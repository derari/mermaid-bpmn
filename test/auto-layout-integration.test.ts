import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/db.js';
import { parser } from '../src/parser.js';
import { renderer } from '../src/render.js';
import { cases } from '../examples/cases.js';
import { getLastBpmnXml } from '../src/lastBpmn.js';

// End-to-end check for `layout auto`: DSL -> bpmn-auto-layout -> SVG.
// Uses the same minimal DOM stub as the ELK shape tests.

class El {
  nodeName: string;
  children: El[] = [];
  attrs: Record<string, string> = {};
  html = '';
  private text = '';

  constructor(name: string) {
    this.nodeName = name;
  }

  setAttribute(k: string, v: string): void {
    this.attrs[k] = String(v);
  }

  getAttribute(k: string): string | null {
    return this.attrs[k] ?? null;
  }

  appendChild(c: El): El {
    this.children.push(c);
    return c;
  }

  remove(): void {}

  get firstChild(): El | null {
    return this.children[0] ?? null;
  }

  set textContent(v: string) {
    this.text = v;
  }

  get textContent(): string {
    return this.text;
  }

  set innerHTML(v: string) {
    this.html = v;
  }

  get innerHTML(): string {
    return this.html;
  }

  getComputedTextLength(): number {
    return this.text.length * 8;
  }
}

let svg: El;
const origDocument = (globalThis as { document?: unknown }).document;

beforeAll(() => {
  (globalThis as { document?: unknown }).document = {
    createElementNS: (_ns: string, name: string) => new El(name),
    getElementById: () => svg,
  };
});

afterAll(() => {
  (globalThis as { document?: unknown }).document = origDocument;
});

beforeEach(() => {
  svg = new El('svg');
  db.clear();
});

async function render(code: string): Promise<void> {
  parser.parse(code);
  // Guard against silently exercising the ELK path: every case here is written
  // against `layout auto`, and a header-level `layout` keyword is not a thing.
  expect(db.getLayoutAlgorithm()).toBe('auto');
  await renderer.draw(code, 'x');
}

function descendants(el: El = svg): El[] {
  return el.children.flatMap((c) => [c, ...descendants(c)]);
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The drawn activity boxes, in draw order. */
function shapes(): Box[] {
  return descendants()
    .filter((e) => e.nodeName === 'rect' && (e.attrs.class ?? '').includes('bpmn'))
    .map((e) => ({
      x: Number(e.attrs.x),
      y: Number(e.attrs.y),
      w: Number(e.attrs.width),
      h: Number(e.attrs.height),
    }));
}

/**
 * Every non-empty caption drawn anywhere in the SVG. The text measurer parks a
 * scratch node off-canvas at -9999; it is not part of the drawing.
 */
function labels(): string[] {
  return descendants()
    .filter((e) => e.nodeName === 'text' || e.nodeName === 'tspan')
    .filter((e) => e.attrs.x !== '-9999')
    .map((e) => e.textContent)
    .filter((t) => t.length > 0);
}

/** The drawn connections. */
function edgePaths(): string[] {
  return descendants()
    .filter((e) => e.nodeName === 'path' && (e.attrs.class ?? '').includes('bpmn-edge'))
    .map((e) => e.attrs.d);
}

/** The drawn event circles (the outer ring of each event). */
function circles(): { cx: number; cy: number; r: number }[] {
  return descendants()
    .filter((e) => e.nodeName === 'circle')
    .map((e) => ({
      cx: Number(e.attrs.cx),
      cy: Number(e.attrs.cy),
      r: Number(e.attrs.r),
    }));
}

/** The drawn gateway diamonds. */
function polygons(): string[] {
  return descendants()
    .filter((e) => e.nodeName === 'polygon')
    .map((e) => e.attrs.points);
}

/** The bounding box of a `points` list. */
function pointsBox(points: string): Box {
  const pairs = points.split(' ').map((p) => p.split(',').map(Number));
  const xs = pairs.map((p) => p[0]);
  const ys = pairs.map((p) => p[1]);
  return {
    x: Math.min(...xs),
    y: Math.min(...ys),
    w: Math.max(...xs) - Math.min(...xs),
    h: Math.max(...ys) - Math.min(...ys),
  };
}

/** The drawn icon glyphs (event/gateway type markers, activity markers). */
function icons(): string[] {
  return descendants()
    .filter((e) => (e.attrs.class ?? '') === 'bpmn-icon')
    .map((e) => e.innerHTML);
}

function viewBox(): Box {
  const [x, y, w, h] = (svg.attrs.viewBox ?? '').split(' ').map(Number);
  return { x, y, w, h };
}

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

describe('layout auto', () => {
  it('draws a single task as a visible, non-degenerate box', async () => {
    await render('bpmn\n  layout auto\n  task A');

    const boxes = shapes();
    expect(boxes).toHaveLength(1);
    expect(boxes[0].w).toBeGreaterThan(0);
    expect(boxes[0].h).toBeGreaterThan(0);
  });

  it('draws an unnamed task', async () => {
    await render('bpmn\n  layout auto\n  task');
    expect(shapes()).toHaveLength(1);
  });

  it('keeps every shape inside the viewBox', async () => {
    await render('bpmn\n  layout auto\n  task A\n  task B\n  A --> B');

    const { w, h } = viewBox();
    expect(w).toBeGreaterThan(0);
    expect(h).toBeGreaterThan(0);
    for (const box of shapes()) {
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.w).toBeLessThanOrEqual(w);
      expect(box.y + box.h).toBeLessThanOrEqual(h);
    }
  });

  it('draws a caption for every named task', async () => {
    await render('bpmn\n  layout auto\n  task A\n  task B\n  A --> B');
    expect(labels()).toEqual(expect.arrayContaining(['A', 'B']));
  });

  it('draws a caption for a quoted label', async () => {
    await render('bpmn\n  layout auto\n  task "Approve request"');
    expect(labels().join(' ')).toContain('Approve');
  });

  it('draws captions for tasks that share a name', async () => {
    await render('bpmn\n  layout auto\n  task A\n  task A');
    expect(shapes()).toHaveLength(2);
    expect(labels().filter((t) => t === 'A')).toHaveLength(2);
  });

  it('connects a flow with a drawn line', async () => {
    await render('bpmn\n  layout auto\n  task A\n  task B\n  A --> B');
    expect(edgePaths()).toHaveLength(1);
    expect(edgePaths()[0]).toMatch(/^M/);
  });

  it('places a flow left to right, not stacked', async () => {
    await render('bpmn\n  layout auto\n  task A\n  task B\n  A --> B');

    const [a, b] = shapes();
    expect(b.x).toBeGreaterThan(a.x + a.w);
    expect(b.y).toBe(a.y);
  });

  it.each([
    ['a chain', 'bpmn\n  layout auto\n  task A\n  task B\n  task C\n  A --> B\n  B --> C'],
    ['a branch', 'bpmn\n  layout auto\n  task A\n  task B\n  task C\n  A --> B\n  A --> C'],
    ['a join', 'bpmn\n  layout auto\n  task A\n  task B\n  task C\n  A --> C\n  B --> C'],
    ['unconnected tasks', 'bpmn\n  layout auto\n  task A\n  task B\n  task C'],
  ])('lays out %s without overlapping shapes', async (_name, code) => {
    await render(code);

    const boxes = shapes();
    expect(boxes).toHaveLength(3);
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        expect(overlaps(boxes[i], boxes[j])).toBe(false);
      }
    }
  });

  it('lays out a diamond with all four flows drawn', async () => {
    await render(
      'bpmn\n  layout auto\n  task A\n  task B\n  task C\n  task D\n  A --> B\n  A --> C\n  B --> D\n  C --> D',
    );
    expect(shapes()).toHaveLength(4);
    expect(edgePaths()).toHaveLength(4);
  });

  it('is deterministic across renders', async () => {
    const code = 'bpmn\n  layout auto\n  task A\n  task B\n  A --> B';
    await render(code);
    const first = shapes();

    svg = new El('svg');
    db.clear();
    await render(code);

    expect(shapes()).toEqual(first);
  });
});

// bpmn-auto-layout sizes every shape from fixed constants and ignores labels, so
// a caption has to be fitted into the box rather than the other way round.
describe('layout auto captions', () => {
  const LINE_H = 18;

  it('keeps a caption that fits on one line', async () => {
    await render('bpmn\n  layout auto\n  task A');
    expect(labels()).toEqual(['A']);
  });

  it('wraps a long caption over several lines', async () => {
    await render('bpmn\n  layout auto\n  task "Approve the quarterly budget request"');
    expect(labels().length).toBeGreaterThan(1);
  });

  it('keeps every wrapped line inside the shape', async () => {
    await render('bpmn\n  layout auto\n  task "Approve the quarterly budget request"');

    const [box] = shapes();
    // The measurer in this stub reports 8px per character.
    for (const line of labels()) expect(line.length * 8).toBeLessThanOrEqual(box.w);
    expect(labels().length * LINE_H).toBeLessThanOrEqual(box.h);
  });

  it('truncates with an ellipsis when the caption outgrows the shape', async () => {
    await render(
      'bpmn\n  layout auto\n  task "aaaaaaaa bbbbbbbb cccccccc dddddddd eeeeeeee ffffffff gggggggg"',
    );

    const [box] = shapes();
    const drawn = labels();
    expect(drawn.length * LINE_H).toBeLessThanOrEqual(box.h);
    expect(drawn[drawn.length - 1].endsWith('\u2026')).toBe(true);
  });

  it('breaks a single word that is wider than the shape', async () => {
    await render('bpmn\n  layout auto\n  task "supercalifragilisticexpialidocious"');

    const [box] = shapes();
    expect(labels().length).toBeGreaterThan(1);
    for (const line of labels()) expect(line.length * 8).toBeLessThanOrEqual(box.w);
  });

  it('wraps the captions of connected tasks independently', async () => {
    await render('bpmn\n  layout auto\n  task A "a much longer caption here"\n  task B\n  A --> B');
    const boxes = shapes();
    expect(boxes).toHaveLength(2);
    expect(edgePaths()).toHaveLength(1);
    expect(labels()).toContain('B');
    for (const line of labels()) expect(line.length * 8).toBeLessThanOrEqual(boxes[0].w);
  });
});

describe('layout auto events and gateways', () => {
  it('draws a start event as a circle', async () => {
    await render('bpmn\n  layout auto\n  start Begin');
    expect(circles()).toHaveLength(1);
    expect(circles()[0].r).toBeGreaterThan(0);
  });

  // An intermediate event is a double ring, an end event a single bold one � the
  // operation has to survive the trip through BPMN and back.
  it('draws an intermediate event as a double ring and an end event as a single one', async () => {
    await render('bpmn\n  layout auto\n  catch Wait');
    expect(circles()).toHaveLength(2);

    db.clear();
    svg = new El('svg');
    await render('bpmn\n  layout auto\n  end Done');
    expect(circles()).toHaveLength(1);
  });

  it('draws a gateway as a diamond', async () => {
    await render('bpmn\n  layout auto\n  gate Choice');
    expect(polygons()).toHaveLength(1);
    const box = pointsBox(polygons()[0]);
    expect(box.w).toBeGreaterThan(0);
    expect(box.w).toBe(box.h);
    // The type marker is resolved and drawn inside the diamond.
    expect(icons()).toHaveLength(1);
  });

  it('draws the type marker of a typed event', async () => {
    await render('bpmn\n  layout auto\n  timer catch T');
    expect(icons()).toHaveLength(1);
  });

  it('lays out a start/gateway/end chain without overlaps and with every flow drawn', async () => {
    await render(
      'bpmn\n  layout auto\n  start S\n  gate G\n  task A\n  task B\n  end E\n' +
        '  S --> G\n  G --> A\n  G --> B\n  A --> E\n  B --> E',
    );

    expect(circles().length).toBeGreaterThanOrEqual(2);
    expect(polygons()).toHaveLength(1);
    expect(shapes()).toHaveLength(2);
    expect(edgePaths()).toHaveLength(5);

    const boxes = shapes();
    expect(overlaps(boxes[0], boxes[1])).toBe(false);
  });

  it('places the gateway between its predecessor and its successors', async () => {
    await render('bpmn\n  layout auto\n  task A\n  gate G\n  task B\n  A --> G\n  G --> B');
    const gateBox = pointsBox(polygons()[0]);
    const [a, b] = shapes();
    expect(a.x + a.w).toBeLessThanOrEqual(gateBox.x);
    expect(gateBox.x + gateBox.w).toBeLessThanOrEqual(b.x);
  });

  it('draws an events caption outside the circle and inside the viewBox', async () => {
    await render('bpmn\n  layout auto\n  start "Order received"');

    expect(labels()).toContain('Order received');
    const { cx, cy, r } = circles()[0];
    const caption = descendants().find(
      (e) => e.nodeName === 'text' && e.textContent === 'Order received' && e.attrs.x !== '-9999',
    )!;
    const x = Number(caption.attrs.x);
    const y = Number(caption.attrs.y);
    expect(y).toBeGreaterThan(cy + r);

    const { w, h } = viewBox();
    expect(x).toBeGreaterThanOrEqual(0);
    expect(y).toBeLessThanOrEqual(h);
    expect(w).toBeGreaterThan(0);
    // A caption wider than the circle must not be truncated to fit it.
    expect(labels()).not.toContain('Order�');
    expect(cx).toBeGreaterThan(0);
  });

  it('keeps a boundary event attached to its host', async () => {
    await render('bpmn\n  layout auto\n  task A\n    timer boundary T\n  task B\n  A --> B');

    expect(shapes()).toHaveLength(2);
    const host = shapes()[0];
    const [ring] = circles();
    // The circle sits on the host border, so its centre is within a radius of it.
    expect(ring.cx).toBeGreaterThanOrEqual(host.x - ring.r);
    expect(ring.cx).toBeLessThanOrEqual(host.x + host.w + ring.r);
    expect(ring.cy).toBeGreaterThanOrEqual(host.y - ring.r);
    expect(ring.cy).toBeLessThanOrEqual(host.y + host.h + ring.r);
  });

  it('draws a sub-process as a box holding its children', async () => {
    await render(
      'bpmn\n  layout auto\n  subprocess Sub "Handle"\n    task A\n    task B\n' +
        '    A --> B\n  task C\n  Sub --> C',
    );

    const boxes = shapes();
    expect(boxes).toHaveLength(4);

    // The sub-process is the only box that encloses another one.
    const inner = boxes.filter((b) => b.w === 100 && b.h === 80);
    const sub = boxes.find((b) => !inner.includes(b))!;
    expect(sub).toBeDefined();

    const contained = inner.filter(
      (b) =>
        b.x >= sub.x && b.y >= sub.y && b.x + b.w <= sub.x + sub.w && b.y + b.h <= sub.y + sub.h,
    );
    expect(contained).toHaveLength(2);
    expect(overlaps(contained[0], contained[1])).toBe(false);

    // The outer task sits beside the sub-process, not in it.
    const outer = inner.find((b) => !contained.includes(b))!;
    expect(overlaps(outer, sub)).toBe(false);

    // Both the inner and the outer flow are drawn.
    expect(edgePaths()).toHaveLength(2);
    expect(labels()).toContain('Handle');
  });

  it('fits the whole sub-process into the viewBox', async () => {
    await render(
      'bpmn\n  layout auto\n  subprocess Sub "Handle"\n    task A\n    task B\n    A --> B',
    );

    const { w, h } = viewBox();
    for (const box of shapes()) {
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.w).toBeLessThanOrEqual(w);
      expect(box.y + box.h).toBeLessThanOrEqual(h);
    }
  });

  it('lays out a sub-process nested in a sub-process', async () => {
    await render(
      'bpmn\n  layout auto\n  subprocess Outer "Outer"\n    subprocess Inner "Inner"\n' +
        '      task A\n      task B\n      A --> B',
    );

    const boxes = shapes();
    expect(boxes).toHaveLength(4);
    const encloses = (a: (typeof boxes)[number], b: (typeof boxes)[number]): boolean =>
      a !== b && b.x >= a.x && b.y >= a.y && b.x + b.w <= a.x + a.w && b.y + b.h <= a.y + a.h;

    // Outer holds three boxes, Inner holds two of them.
    const counts = boxes
      .map((a) => boxes.filter((b) => encloses(a, b)).length)
      .sort((x, y) => y - x);
    expect(counts).toEqual([3, 2, 0, 0]);
  });
});

describe('layout auto artifacts', () => {
  /** Every drawn box together with the class it carries, in draw order. */
  function boxesWithClass(): (Box & { cls: string })[] {
    return descendants()
      .filter((e) => e.nodeName === 'rect' && (e.attrs.class ?? '').includes('bpmn'))
      .map((e) => ({
        x: Number(e.attrs.x),
        y: Number(e.attrs.y),
        w: Number(e.attrs.width),
        h: Number(e.attrs.height),
        cls: e.attrs.class ?? '',
      }));
  }

  const encloses = (a: Box, b: Box): boolean =>
    b.x >= a.x && b.y >= a.y && b.x + b.w <= a.x + a.w && b.y + b.h <= a.y + a.h;

  it('draws a data object beside the task it hangs off', async () => {
    await render('bpmn\n  layout auto\n  task A\n  data D\n  A --> D');

    expect(shapes().length).toBeGreaterThanOrEqual(1);
    expect(edgePaths()).toHaveLength(1);
    expect(labels()).toEqual(expect.arrayContaining(['A', 'D']));
  });

  // A connection to a data element or an annotation is a BPMN association, drawn
  // dotted rather than as a solid sequence flow.
  it('draws a connection to a data object as an association', async () => {
    await render('bpmn\n  layout auto\n  task A\n  data D\n  A --> D');
    const classes = descendants()
      .filter((e) => e.nodeName === 'path' && (e.attrs.class ?? '').includes('bpmn-edge'))
      .map((e) => e.attrs.class);
    expect(classes).toEqual(['bpmn-edge bpmn-data-assoc']);
  });

  it('draws a data store', async () => {
    await render('bpmn\n  layout auto\n  data store Ledger');
    expect(labels().join('')).toContain('Ledger');
  });

  it('draws a comment attached to a task', async () => {
    await render('bpmn\n  layout auto\n  task A\n  comment Note "Needs review"\n  A --- Note');
    expect(edgePaths()).toHaveLength(1);
    expect(labels().join(' ')).toContain('Needs');
  });

  // Nothing carries an unattached annotation through the layouter, so it is
  // placed here instead of vanishing.
  it('still draws a comment that is attached to nothing', async () => {
    await render('bpmn\n  layout auto\n  task A\n  comment Note');

    const { w, h } = viewBox();
    expect(labels()).toEqual(expect.arrayContaining(['A', 'Note']));
    for (const box of shapes()) {
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.w).toBeLessThanOrEqual(w);
      expect(box.y + box.h).toBeLessThanOrEqual(h);
    }
  });

  it('draws a group box around the nodes declared inside it', async () => {
    await render('bpmn\n  layout auto\n  group G\n    task A\n    task B\n  A --> B');

    const boxes = boxesWithClass();
    const group = boxes.find((b) => b.cls.includes('bpmn-group'))!;
    expect(group).toBeDefined();

    const members = boxes.filter((b) => b !== group);
    expect(members).toHaveLength(2);
    for (const member of members) expect(encloses(group, member)).toBe(true);
    expect(labels()).toEqual(expect.arrayContaining(['G', 'A', 'B']));
  });

  // The box is a backdrop: it must not paint over the nodes it surrounds.
  it('draws the group box before its members', async () => {
    await render('bpmn\n  layout auto\n  group G\n    task A\n    task B\n  A --> B');
    expect(boxesWithClass()[0].cls).toContain('bpmn-group');
  });

  it('keeps a group box inside the viewBox', async () => {
    await render('bpmn\n  layout auto\n  group G\n    task A\n    task B\n  A --> B');

    const { w, h } = viewBox();
    for (const box of boxesWithClass()) {
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.w).toBeLessThanOrEqual(w);
      expect(box.y + box.h).toBeLessThanOrEqual(h);
    }
  });

  it('draws a line that touches a group', async () => {
    await render('bpmn\n  layout auto\n  group G\n    task A\n  comment Note\n  Note --- G');

    const boxes = boxesWithClass();
    const group = boxes.find((b) => b.cls.includes('bpmn-group'))!;
    expect(group).toBeDefined();
    // BPMN gives a group no incoming or outgoing, so nothing routes this one; it
    // is drawn straight between the two boxes instead.
    expect(edgePaths()).toHaveLength(1);
    expect(edgePaths()[0]).toMatch(/^M/);
  });

  it('nests a group inside the sub-process that holds it', async () => {
    await render(
      'bpmn\n  layout auto\n  subprocess S\n    group G\n      task A\n      task B\n    A --> B',
    );

    const boxes = boxesWithClass();
    const group = boxes.find((b) => b.cls.includes('bpmn-group'))!;
    const sub = boxes.find((b) => b !== group && encloses(b, group))!;
    expect(sub).toBeDefined();
    expect(boxes.filter((b) => b !== group && encloses(group, b))).toHaveLength(2);
  });
});

describe('layout auto pools and lanes', () => {
  /** Every drawn box together with the class it carries, in draw order. */
  function boxesWithClass(): (Box & { cls: string })[] {
    return descendants()
      .filter((e) => e.nodeName === 'rect' && (e.attrs.class ?? '').includes('bpmn'))
      .map((e) => ({
        x: Number(e.attrs.x),
        y: Number(e.attrs.y),
        w: Number(e.attrs.width),
        h: Number(e.attrs.height),
        cls: e.attrs.class ?? '',
      }));
  }

  const encloses = (a: Box, b: Box): boolean =>
    b.x >= a.x && b.y >= a.y && b.x + b.w <= a.x + a.w && b.y + b.h <= a.y + a.h;

  const withClass = (cls: string): (Box & { cls: string })[] =>
    boxesWithClass().filter((b) => b.cls.includes(cls));

  it('stacks lanes down their pool and puts their tasks inside them', async () => {
    await render(
      'bpmn\n  layout auto\n  pool P\n    lane A\n      task t1\n      task t2\n      t1 --> t2\n    lane B\n      task t3',
    );

    const pool = withClass('bpmn-pool')[0];
    const lanes = withClass('bpmn-lane');
    expect(lanes).toHaveLength(2);
    for (const lane of lanes) expect(encloses(pool, lane)).toBe(true);

    // Lanes are bands: same width, stacked without a gap, filling the pool.
    expect(lanes[0].w).toBe(lanes[1].w);
    expect(lanes[0].x).toBe(lanes[1].x);
    expect(lanes[0].y + lanes[0].h).toBe(lanes[1].y);
    expect(lanes[0].y + lanes[0].h + lanes[1].h).toBe(pool.y + pool.h);

    // The pool's caption strip sits to the left of every lane.
    expect(lanes[0].x).toBeGreaterThan(pool.x);

    const tasks = withClass('bpmn-activity');
    expect(tasks.filter((t) => encloses(lanes[0], t))).toHaveLength(2);
    expect(tasks.filter((t) => encloses(lanes[1], t))).toHaveLength(1);
  });

  it('stacks pools down the diagram, one under the other', async () => {
    await render(
      'bpmn\n  layout auto\n  pool P1\n    lane A\n      task t1\n  pool P2\n    lane B\n      task t2\n      task t3\n      t2 --> t3',
    );

    const pools = withClass('bpmn-pool');
    expect(pools).toHaveLength(2);
    expect(pools[0].x).toBe(pools[1].x);
    expect(pools[0].y + pools[0].h).toBeLessThanOrEqual(pools[1].y);
    expect(overlaps(pools[0], pools[1])).toBe(false);
  });

  it('routes a cross-lane connection between the two tasks', async () => {
    await render(
      'bpmn\n  layout auto\n  pool P\n    lane A\n      task t1\n    lane B\n      task t2\n  t1 --> t2',
    );

    const paths = edgePaths();
    expect(paths).toHaveLength(1);

    // It leaves the upper lane and arrives in the lower one.
    const lanes = withClass('bpmn-lane');
    const ys = [...paths[0].matchAll(/[\d.]+,([\d.]+)/g)].map((m) => Number(m[1]));
    expect(Math.min(...ys)).toBeLessThan(lanes[0].y + lanes[0].h);
    expect(Math.max(...ys)).toBeGreaterThan(lanes[1].y);
  });

  it('draws a lane in one pool and a lane in another without overlap', async () => {
    await render(
      'bpmn\n  layout auto\n  pool P1\n    lane A\n      task t1\n  pool P2\n    lane B\n      task t2\n  t1 --> t2',
    );

    const lanes = withClass('bpmn-lane');
    expect(lanes).toHaveLength(2);
    expect(overlaps(lanes[0], lanes[1])).toBe(false);
    expect(edgePaths()).toHaveLength(1);
  });

  it('gives an empty pool and an empty lane a visible box', async () => {
    await render(
      'bpmn\n  layout auto\n  pool Empty\n  pool P\n    lane Idle\n    lane Busy\n      task t',
    );

    for (const box of [...withClass('bpmn-pool'), ...withClass('bpmn-lane')]) {
      expect(box.w).toBeGreaterThan(0);
      expect(box.h).toBeGreaterThan(0);
    }
    const pools = withClass('bpmn-pool');
    expect(overlaps(pools[0], pools[1])).toBe(false);
  });

  it('captions every pool and lane', async () => {
    await render('bpmn\n  layout auto\n  pool Alpha\n    lane Beta\n      task Gamma');

    expect(labels()).toEqual(expect.arrayContaining(['Alpha', 'Beta', 'Gamma']));
  });

  it('keeps a sub-process inside the lane that declares it', async () => {
    await render(
      'bpmn\n  layout auto\n  pool P\n    lane A\n      subprocess S\n        task i1\n        task i2\n        i1 --> i2',
    );

    const lane = withClass('bpmn-lane')[0];
    const sub = withClass('bpmn-activity').find((b) => b.cls.includes('bpmn-container'))!;
    expect(sub).toBeDefined();
    expect(encloses(lane, sub)).toBe(true);
  });

  // The layouter refuses a whole document over one artifact it cannot find room
  // for, so the flow is laid out again without them rather than dropped to a grid.
  it('still lays out the flow when an artifact cannot be placed', async () => {
    await render(
      'bpmn\n  layout auto\n  subprocess S\n    task i1\n    task i2\n    i1 --> i2\n  data D\n  S -- D',
    );

    const boxes = withClass('bpmn-activity');
    // The sub-process box still surrounds both of its tasks.
    const sub = boxes.find((b) => b.cls.includes('bpmn-container'))!;
    expect(sub).toBeDefined();
    expect(boxes.filter((b) => b !== sub && encloses(sub, b))).toHaveLength(2);

    // The data object is still drawn, and its association with it.
    expect(labels()).toEqual(expect.arrayContaining(['D']));
    expect(edgePaths()).toHaveLength(db.getLines().length);
  });

  it('draws a cross-pool connection as a message flow', async () => {
    await render(
      'bpmn\n  layout auto\n  pool P1\n    lane A\n      task t1\n  pool P2\n    lane B\n      task t2\n  t1 --> t2',
    );

    const dashed = descendants().filter(
      (e) => e.nodeName === 'path' && (e.attrs.class ?? '').includes('bpmn-message-flow'),
    );
    expect(dashed).toHaveLength(1);
  });
});

describe('layout auto examples', () => {
  it.each(
    cases.filter((c) => c.code.includes('layout auto')).map((c) => [c.title, c.code] as const),
  )('renders %s with every node and flow drawn', async (_title, code) => {
    await render(code);
    const drawn = shapes().length + circles().length + polygons().length;
    expect(drawn).toBeGreaterThan(0);
    expect(edgePaths().length).toBe(db.getLines().length);
    expect(labels().length).toBeGreaterThan(0);
  });
});

// The editor offers the layouted document as a download, so it has to be the
// one the drawing was actually made from, and it must not outlive its diagram.
describe('layout auto exported document', () => {
  it('exposes the layouted BPMN behind the diagram', async () => {
    await render('bpmn LR\n  layout auto\n  pool P {\n    lane L {\n      task T\n    }\n  }');

    const xml = getLastBpmnXml();
    expect(xml).toBeDefined();
    // The semantic model...
    expect(xml).toContain('<bpmn:participant id="P"');
    expect(xml).toContain('<bpmn:lane id="L"');
    // ...and the diagram interchange that positions it.
    expect(xml).toContain('<bpmndi:BPMNShape');
    expect(xml).toMatch(/<dc:Bounds[^>]*width="\d/);
  });

  it('reports no document for an elk diagram', async () => {
    await render('bpmn LR\n  layout auto\n  task T');
    expect(getLastBpmnXml()).toBeDefined();

    parser.parse('bpmn LR\n  task T');
    expect(db.getLayoutAlgorithm()).toBe('elk');
    await renderer.draw('bpmn LR\n  task T', 'x');
    expect(getLastBpmnXml()).toBeUndefined();
  });
});
