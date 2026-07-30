import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/db.js';
import { parser } from '../src/parser.js';
import { renderer } from '../src/render.js';

// Integration tests that run the REAL renderer (ELK layout + SVG build) under a
// minimal DOM stub, covering the BPMN SHAPE vocabulary: how each family is sized,
// which outline it draws, where its caption lands, and how pools fit their lanes.
// Everything here is about what `bpmnStyle.ts` puts on the canvas — the routing
// engine's own behaviour (black-boxes, port chains, bridges) is exercised by
// `routing.elk.test.ts` instead.

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
  // Icon <svg>s set their body via innerHTML; capture it so tests can tell one
  // resolved glyph from another (the real DOM parses it into child nodes).
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
  svg = new El('svg');
  (globalThis as { document?: unknown }).document = {
    createElementNS: (_ns: string, name: string) => new El(name),
    getElementById: () => svg,
  };
});
afterAll(() => {
  (globalThis as { document?: unknown }).document = origDocument;
});

// All edge elements anywhere in the built SVG (edges are appended flat, drawn as
// <path> now). Filter by the `bpmn-edge` class so arrowhead <path>s (which live in
// markers and carry `bpmn-arrow`) are excluded.
function edges(): El[] {
  return svg.children.filter((e) => e.nodeName === 'path' && e.attrs.class?.includes('bpmn-edge'));
}
// Count of edges carrying an arrowhead (a real line's single head).
function heads(): number {
  return edges().filter((p) => p.attrs['marker-start'] || p.attrs['marker-end']).length;
}
// Finds a <marker> anywhere in the tree by its url(#id) reference.
function markerByRef(ref: string | undefined): El | undefined {
  const id = ref?.match(/#(.+)\)/)?.[1];
  if (!id) return undefined;
  let found: El | undefined;
  const walk = (e: El): void => {
    if (e.nodeName === 'marker' && e.attrs.id === id) found = e;
    for (const c of e.children) walk(c);
  };
  walk(svg);
  return found;
}

async function render(code: string): Promise<void> {
  svg.children = [];
  db.clear();
  parser.parse(code);
  await renderer.draw(code, 'x');
}

describe('BPMN shapes (real ELK)', () => {
  const findRect = (cls: string) =>
    svg.children.filter((e) => e.nodeName === 'rect' && e.attrs.class?.includes(cls));

  it('renders an empty horizontal pool as a sharp-cornered fixed-size box', async () => {
    await render('bpmn LR\n  pool "Orders"');
    const [pool] = findRect('bpmn-pool');
    expect(pool).toBeDefined();
    // Carries the common entity outline, and is not a container (a leaf, no lanes).
    expect(pool.attrs.class).toContain('bpmn-entity');
    expect(pool.attrs.class).not.toContain('bpmn-container');
    // Sharp corners: no rounding (only activities round).
    expect(pool.attrs.rx).toBeUndefined();
    // Horizontal: eight activity widths by two activity heights (80×44 → 640×88).
    expect(Number(pool.attrs.width)).toBe(640);
    expect(Number(pool.attrs.height)).toBe(88);
  });

  it('swaps the empty pool dimensions for a vertical flow', async () => {
    await render('bpmn TB\n  pool "Orders"');
    const [pool] = findRect('bpmn-pool');
    expect(Number(pool.attrs.width)).toBe(88);
    expect(Number(pool.attrs.height)).toBe(640);
  });

  it('gives each line landing on a pool its own port, on the side facing the source', async () => {
    // Two lines land directly on the black-box pool P; with `debug ports` the
    // router's ports draw as small squares. Each line mints its own port on P.
    // The root toggles to a vertical layout (it holds a pool), so P sits on top and
    // the tasks below it: both ports should land on P's SOUTH edge (facing the
    // tasks), at distinct points along it rather than stacked.
    await render(
      ['bpmn LR', '  debug ports', '  pool P', '  task A', '  task B', '  A --> P', '  B --> P'].join('\n'),
    );
    const [pool] = findRect('bpmn-pool');
    const poolBottom = Number(pool.attrs.y) + Number(pool.attrs.height);
    const ports = svg.children.filter(
      (e) => e.nodeName === 'rect' && e.attrs.class?.includes('bpmn-port'),
    );
    expect(ports.length).toBe(2);
    // Port marker rects are drawn centred on the port point (offset by PORT_MARK/2=3).
    const centres = ports.map((p) => ({ x: Number(p.attrs.x) + 3, y: Number(p.attrs.y) + 3 }));
    // Both sit on the pool's bottom edge…
    expect(centres.every((c) => Math.abs(c.y - poolBottom) < 2)).toBe(true);
    // …at distinct x's (ELK spread them along the side).
    expect(new Set(centres.map((c) => c.x)).size).toBe(2);
  });

  it('renders a pool with lanes: a pool box plus a stretched lane box per lane', async () => {
    await render(
      ['bpmn LR', '  pool P', '    lane A', '    lane B'].join('\n'),
    );
    const [pool] = findRect('bpmn-pool');
    const lanes = findRect('bpmn-lane');
    expect(pool).toBeDefined();
    expect(pool.attrs.class).toContain('bpmn-container'); // has lanes now
    expect(lanes.length).toBe(2);
    // Lanes stretch to a common width (span the pool's content) and stack (differ in y).
    expect(lanes[0].attrs.width).toBe(lanes[1].attrs.width);
    expect(lanes[0].attrs.y).not.toBe(lanes[1].attrs.y);
    // Pool width = its label band (30) + the lane content width.
    expect(Number(pool.attrs.width)).toBe(30 + Number(lanes[0].attrs.width));
    // Both lanes sit to the right of the pool's left band.
    expect(Number(lanes[0].attrs.x)).toBe(Number(pool.attrs.x) + 30);
  });

  it("a lane fills its pool's cross-axis even when a crossing edge grows the pool", async () => {
    // Regression: a boundary-crossing line makes ELK grow the pool a few pixels
    // past its lone lane; the lane must still tile the pool's full cross extent
    // (its height for an LR pool), leaving no gap along the top or bottom.
    await render(
      [
        'bpmn TB',
        '  pool A LR',
        '    lane Bobs Lane',
        '      manual task Bob',
        '        --> Alice',
        '  pool B LR',
        '    lane Alices Lane',
        '      user task Alice',
      ].join('\n'),
    );
    const pools = findRect('bpmn-pool');
    const lanes = findRect('bpmn-lane');
    expect(pools.length).toBe(2);
    expect(lanes.length).toBe(2);
    pools.forEach((pool, i) => {
      const lane = lanes[i];
      // The lane spans the pool's full height and shares its top and bottom edge.
      expect(Number(lane.attrs.y)).toBe(Number(pool.attrs.y));
      expect(Number(lane.attrs.height)).toBe(Number(pool.attrs.height));
    });
  });

  it('stacks root pools ACROSS the diagram flow (LR diagram → pools top-to-bottom)', async () => {
    // A root holding pools toggles its layout axis (LR → TB), so the two pools stack
    // vertically — the classic swimlane arrangement — sharing x and differing in y.
    await render(['bpmn LR', '  pool A', '    lane LA', '  pool B', '    lane LB'].join('\n'));
    const pools = findRect('bpmn-pool');
    expect(pools.length).toBe(2);
    expect(Number(pools[0].attrs.x)).toBe(Number(pools[1].attrs.x));
    expect(Number(pools[0].attrs.y)).not.toBe(Number(pools[1].attrs.y));
  });

  it('toggles the root layout axis for a vertical diagram (TB → pools side by side)', async () => {
    // TB toggles to an LR root layout: the pools sit side by side (share y, differ in x).
    await render(['bpmn TB', '  pool A', '    lane LA', '  pool B', '    lane LB'].join('\n'));
    const pools = findRect('bpmn-pool');
    expect(pools.length).toBe(2);
    expect(Number(pools[0].attrs.y)).toBe(Number(pools[1].attrs.y));
    expect(Number(pools[0].attrs.x)).not.toBe(Number(pools[1].attrs.x));
  });

  it('keeps stacked pools aligned even when message flows run between them', async () => {
    // Regression: cross-pool edges tempt ELK's default (Brandes-Köpf) node placement
    // to slide a pool sideways to shorten them, breaking the swimlane stack. The
    // pools must still share a cross-axis origin (same x for a vertical stack).
    await render(
      [
        'bpmn',
        '  pool P1',
        '  pool',
        '    lane',
        '      task',
        '        --> P1',
        '      task',
        '        --> P1',
      ].join('\n'),
    );
    const pools = findRect('bpmn-pool');
    expect(pools.length).toBe(2);
    expect(Number(pools[0].attrs.x)).toBe(Number(pools[1].attrs.x));
    expect(Number(pools[0].attrs.y)).not.toBe(Number(pools[1].attrs.y));
  });

  it('extends same-direction pools to a common length (LR → equal widths, aligned)', async () => {
    // Two LR pools of different content lengths. ELK sizes each to its own content
    // (and centres the shorter one), leaving the stack ragged; they must be pulled
    // to the longest pool's width and left-aligned, the way lanes share one length.
    await render(
      [
        'bpmn LR',
        '  pool Long',
        '    lane L1',
        '      task A',
        '      task B',
        '      task C',
        '      A --> B',
        '      B --> C',
        '  pool Short',
        '    lane L2',
        '      task E',
      ].join('\n'),
    );
    const pools = findRect('bpmn-pool');
    expect(pools.length).toBe(2);
    // Equal width (the longest) and a shared left edge — right edges line up.
    expect(Number(pools[0].attrs.width)).toBe(Number(pools[1].attrs.width));
    expect(Number(pools[0].attrs.x)).toBe(Number(pools[1].attrs.x));
    // The stretch is real: the short pool grew past its lone task's width.
    expect(Number(pools[1].attrs.width)).toBeGreaterThan(150);
  });

  it('extends only pools that share a direction (a lone TB pool keeps its own length)', async () => {
    // Two LR pools and one TB pool. The LR pair equalises to a common width; the
    // TB pool is the only one of its direction, so its height is left untouched.
    await render(
      [
        'bpmn LR',
        '  pool H1 LR',
        '    lane a',
        '      task A',
        '      task B',
        '      A --> B',
        '  pool H2 LR',
        '    lane b',
        '      task C',
        '  pool V1 TB',
        '    lane c',
        '      task D',
        '      task E',
        '      D --> E',
      ].join('\n'),
    );
    const pools = findRect('bpmn-pool');
    expect(pools.length).toBe(3);
    const [h1, h2, v1] = pools;
    // The two LR pools match widths…
    expect(Number(h1.attrs.width)).toBe(Number(h2.attrs.width));
    // …while the lone TB pool keeps a height driven by its own two stacked tasks,
    // taller than the single-row LR pools (i.e. it was not forced to their length).
    expect(Number(v1.attrs.height)).toBeGreaterThan(Number(h1.attrs.height));
  });

  it('reverses a reversed pool\'s lane order (RL flow → BT lane stack, sign preserved)', async () => {
    // The pool→lane toggle preserves the sign: an RL pool stacks its lanes along BT,
    // so they still stack vertically but the first-declared lane sits at the BOTTOM
    // (the old sign-losing map put it on top).
    await render(['bpmn', '  pool P RL', '    lane LA', '    lane LB'].join('\n'));
    const lanes = findRect('bpmn-lane');
    expect(lanes.length).toBe(2);
    expect(Number(lanes[0].attrs.x)).toBe(Number(lanes[1].attrs.x)); // vertical stack
    expect(Number(lanes[0].attrs.y)).toBeGreaterThan(Number(lanes[1].attrs.y)); // LA below LB
  });

  it('draws a cross-pool line as a message flow: dashed, origin circle, hollow head', async () => {
    await render(
      [
        'bpmn TB',
        '  pool A LR',
        '    lane Bobs Lane',
        '      manual task Bob',
        '        --> Alice',
        '  pool B LR',
        '    lane Alices Lane',
        '      user task Alice',
      ].join('\n'),
    );
    const es = edges();
    expect(es.length).toBe(1);
    const edge = es[0];
    // Dashed message-flow class.
    expect(edge.attrs.class).toContain('bpmn-message-flow');
    // The origin circle sits at the source end, the arrowhead at the target end.
    const circle = markerByRef(edge.attrs['marker-start']);
    const head = markerByRef(edge.attrs['marker-end']);
    expect(circle?.children[0]?.nodeName).toBe('circle');
    expect(head?.children[0]?.nodeName).toBe('path');
    // Both are hollow: filled with the background (#fff), outlined in the line color.
    expect(circle?.children[0]?.attrs.style).toContain('fill:#fff');
    expect(circle?.children[0]?.attrs.style).toContain('stroke:#333');
    expect(head?.children[0]?.attrs.style).toContain('fill:#fff');
    expect(head?.children[0]?.attrs.style).toContain('stroke:#333');
  });

  it('keeps a same-pool line a plain solid sequence flow', async () => {
    await render(
      [
        'bpmn LR',
        '  pool A LR',
        '    lane L',
        '      task X',
        '      task Y',
        '      X --> Y',
      ].join('\n'),
    );
    const es = edges();
    expect(es.length).toBe(1);
    expect(es[0].attrs.class).toBe('bpmn-edge'); // not a message flow
    expect(es[0].attrs['marker-start']).toBeUndefined(); // no origin circle
  });

  it('draws a data association dotted with an open "V" head, not a message flow', async () => {
    await render(
      [
        'bpmn LR',
        '  task Bob',
        '    --> DS',
        '  data store DS',
      ].join('\n'),
    );
    const es = edges();
    expect(es.length).toBe(1);
    const edge = es[0];
    // Dotted data-association class, no origin circle.
    expect(edge.attrs.class).toContain('bpmn-data-assoc');
    expect(edge.attrs.class).not.toContain('bpmn-message-flow');
    expect(edge.attrs['marker-start']).toBeUndefined();
    // The head is an open "V": a stroked, unfilled polyline.
    const head = markerByRef(edge.attrs['marker-end']);
    expect(head?.children[0]?.nodeName).toBe('path');
    expect(head?.children[0]?.attrs.style).toContain('fill:none');
    expect(head?.children[0]?.attrs.style).toContain('stroke:#333');
  });

  it('keeps a data association dotted even when it crosses pools', async () => {
    // A data line takes the data-association look regardless of pool crossing (it is
    // never promoted to a message flow).
    await render(
      [
        'bpmn TB',
        '  pool A LR',
        '    lane L',
        '      task Bob',
        '        --> DS',
        '  pool B LR',
        '    lane M',
        '      data store DS',
      ].join('\n'),
    );
    const es = edges();
    expect(es.length).toBe(1);
    expect(es[0].attrs.class).toContain('bpmn-data-assoc');
    expect(es[0].attrs.class).not.toContain('bpmn-message-flow');
  });

  it('draws a data collection as a data object plus three parallel marker bars', async () => {
    await render('bpmn LR\n  data collection Items');
    // The data-object silhouette (folded-corner polygon) is still drawn.
    const polys = svg.children.filter(
      (e) => e.nodeName === 'polygon' && e.attrs.class?.includes('bpmn-data'),
    );
    expect(polys.length).toBe(1);
    // The collection marker: exactly three vertical bars (<line>s), evenly spaced.
    const bars = svg.children.filter(
      (e) => e.nodeName === 'line' && e.attrs.class?.includes('bpmn-data'),
    );
    expect(bars.length).toBe(3);
    // All three are vertical (x1 === x2) and share their top/bottom (a level row).
    expect(bars.every((b) => b.attrs.x1 === b.attrs.x2)).toBe(true);
    expect(new Set(bars.map((b) => b.attrs.y1)).size).toBe(1);
    // Their x's are distinct and evenly spaced around the centre.
    const xs = bars.map((b) => Number(b.attrs.x1)).sort((a, b) => a - b);
    expect(xs[1] - xs[0]).toBeCloseTo(xs[2] - xs[1]);
  });

  it('draws a plain data object without collection marker bars', async () => {
    await render('bpmn LR\n  data object d');
    const bars = svg.children.filter(
      (e) => e.nodeName === 'line' && e.attrs.class?.includes('bpmn-data'),
    );
    expect(bars.length).toBe(0);
  });

  it('draws the subprocess (composite) marker after the loop marker', async () => {
    // A collapsed loop subprocess carries both a loop marker and the composite `+`.
    // The composite must come LAST — to the right of the loop marker.
    await render('bpmn LR\n  loop subprocess "Looped"');
    const markers = svg.children
      .filter((e) => e.nodeName === 'svg' && e.attrs.class?.includes('bpmn-icon'))
      .map((e) => ({
        // The loop glyph is mirrored (scale(-1 1)); the composite is a boxed plus.
        kind: e.html.includes('scale(-1 1)')
          ? 'loop'
          : e.html.includes('rect') && e.html.includes('M12 7v10')
            ? 'composite'
            : 'other',
        x: Number(e.attrs.x),
      }));
    const loop = markers.find((m) => m.kind === 'loop');
    const composite = markers.find((m) => m.kind === 'composite');
    expect(loop).toBeDefined();
    expect(composite).toBeDefined();
    expect(composite!.x).toBeGreaterThan(loop!.x);
  });

  it('grows a data object and store wide enough to fit a long caption', async () => {
    // Object width = right-x − left-x of its folded-corner polygon (points are
    // "L,T R-f,T R,T+f R,B L,B"): compare corner 2 (R) with corner 0 (L).
    const objectWidth = (): number => {
      const poly = svg.children.find(
        (e) => e.nodeName === 'polygon' && e.attrs.class?.includes('bpmn-data'),
      );
      const pts = poly!.attrs.points.split(' ').map((p) => Number(p.split(',')[0]));
      return pts[2] - pts[0];
    };
    // Store width = R − L pulled from its cylinder path ("M L,.. A rx,ry 0 0 1 R,..").
    const storeWidth = (): number => {
      const path = svg.children.find(
        (e) => e.nodeName === 'path' && e.attrs.class?.includes('bpmn-data'),
      );
      const m = path!.attrs.d.match(/M\s+([\d.]+),[\d.]+\s+A\s+[\d.]+,[\d.]+\s+0\s+0\s+1\s+([\d.]+),/);
      return Number(m![2]) - Number(m![1]);
    };

    await render('bpmn LR\n  data object "x"');
    const narrowObj = objectWidth();
    expect(narrowObj).toBe(72); // the default DATA_W for a short caption
    await render('bpmn LR\n  data object "A very long data object caption"');
    expect(objectWidth()).toBeGreaterThan(narrowObj);

    await render('bpmn LR\n  data store "x"');
    const narrowStore = storeWidth();
    expect(narrowStore).toBeCloseTo(72);
    await render('bpmn LR\n  data store "A very long data store caption"');
    expect(storeWidth()).toBeGreaterThan(narrowStore);
  });

  it('draws a line touching a text annotation dotted, like a data association', async () => {
    await render(
      [
        'bpmn LR',
        '  task Bob',
        '  comment note "see spec"',
        '  Bob --- note',
      ].join('\n'),
    );
    const es = edges();
    expect(es.length).toBe(1);
    expect(es[0].attrs.class).toContain('bpmn-data-assoc');
    expect(es[0].attrs.class).not.toContain('bpmn-message-flow');
  });

  it('keeps the dotted look when the line goes through a declared port on the text', async () => {
    await render(
      [
        'bpmn LR',
        '  task Bob',
        '  comment note w',
        '    port p e',
        '  Bob --- p',
      ].join('\n'),
    );
    const es = edges();
    expect(es.length).toBe(1);
    // The endpoint is the port, but its owner is the text annotation, so it is still
    // classified as a data association.
    expect(es[0].attrs.class).toContain('bpmn-data-assoc');
    expect(es[0].attrs.class).not.toContain('bpmn-message-flow');
  });

  it('renders a gateway as a diamond (polygon) with a centred type marker', async () => {
    await render('bpmn\n  inclusive gate g');
    const diamond = svg.children.find(
      (e) => e.nodeName === 'polygon' && e.attrs.class?.includes('bpmn-gate'),
    );
    expect(diamond).toBeDefined();
    expect(diamond!.attrs.class).toContain('bpmn-entity');
    // Four points (a diamond) through the box midpoints.
    expect(diamond!.attrs.points.trim().split(/\s+/).length).toBe(4);
    // The type marker is drawn as a nested icon <svg>.
    const icon = svg.children.find((e) => e.nodeName === 'svg' && e.attrs.class === 'bpmn-icon');
    expect(icon).toBeDefined();
  });

  const eventCircles = () =>
    svg.children.filter((e) => e.nodeName === 'circle' && e.attrs.class?.includes('bpmn-event'));

  it('draws a start event as a single thin circle (no marker)', async () => {
    await render('bpmn\n  start');
    const circles = eventCircles();
    expect(circles.length).toBe(1);
    expect(circles[0].attrs.style).not.toContain('dasharray');
    expect(circles[0].attrs.style).not.toContain('stroke-width');
    // Blank event → no marker icon.
    expect(svg.children.some((e) => e.nodeName === 'svg' && e.attrs.class === 'bpmn-icon')).toBe(false);
  });

  it('draws an intermediate (catch) event as a double circle', async () => {
    await render('bpmn\n  catch mid');
    expect(eventCircles().length).toBe(2);
  });

  it('draws an end event as a single thick circle', async () => {
    await render('bpmn\n  end e');
    const circles = eventCircles();
    expect(circles.length).toBe(1);
    expect(circles[0].attrs.style).toContain('stroke-width:4.5');
  });

  it('draws a non-interrupting event with a dashed circle', async () => {
    await render('bpmn\n  non-interrupt ni');
    expect(eventCircles()[0].attrs.style).toContain('stroke-dasharray');
  });

  it('draws a boundary non-interrupt event as a double dashed circle', async () => {
    await render('bpmn\n  boundary continue b');
    const circles = eventCircles();
    expect(circles.length).toBe(2);
    expect(circles.every((c) => c.attrs.style.includes('stroke-dasharray'))).toBe(true);
  });

  it('draws the type marker inside a typed event', async () => {
    await render('bpmn\n  message start m');
    expect(svg.children.some((e) => e.nodeName === 'svg' && e.attrs.class === 'bpmn-icon')).toBe(true);
  });

  // A drawn caption is a <text> that is not the offscreen measurement probe (x=-9999).
  const hasCaption = (t: string): boolean =>
    svg.children.some((e) => e.nodeName === 'text' && e.textContent === t && e.attrs.x !== '-9999');

  it('draws a gateway caption outside only when explicitly set', async () => {
    await render('bpmn\n  gate g');
    expect(hasCaption('g')).toBe(false); // no explicit label → no caption
    await render('bpmn\n  gate g "Choose"');
    expect(hasCaption('Choose')).toBe(true);
  });

  it('draws an event caption outside, defaulting to the event id', async () => {
    await render('bpmn\n  message start received');
    expect(hasCaption('received')).toBe(true);
  });

  describe('text annotation (comment)', () => {
    // The bracket is a polyline carrying bpmn-text; a background rect (only with a
    // fill) carries bpmn-text too but is a <rect>.
    const brackets = () =>
      svg.children.filter(
        (e) => e.nodeName === 'polyline' && e.attrs.class?.includes('bpmn-text'),
      );
    // A polyline's four points, as [x,y] pairs.
    const pts = (p: El) =>
      p.attrs.points.trim().split(/\s+/).map((pt) => pt.split(',').map(Number));

    it('draws a transparent box (no fill rect) with a bold open bracket', async () => {
      await render('bpmn\n  comment note "A note"');
      const bs = brackets();
      expect(bs.length).toBe(1);
      expect(bs[0].attrs.style).toContain('fill:none');
      expect(bs[0].attrs.style).toContain(`stroke-width:2`);
      // No background rect drawn without a fill.
      expect(svg.children.some((e) => e.nodeName === 'rect' && e.attrs.class?.includes('bpmn-text'))).toBe(
        false,
      );
      // The caption is drawn (inside its centred <g>, so search the whole tree).
      let found = false;
      const walk = (e: El): void => {
        if (e.nodeName === 'text' && e.textContent === 'A note') found = true;
        e.children.forEach(walk);
      };
      walk(svg);
      expect(found).toBe(true);
    });

    it('paints a background rect only when a fill is set', async () => {
      await render('bpmn\n  comment note "n"\n    style fill:#eef');
      const bg = svg.children.find((e) => e.nodeName === 'rect' && e.attrs.class?.includes('bpmn-text'));
      expect(bg).toBeDefined();
      expect(bg!.attrs.style).toContain('fill:#eef');
    });

    it('puts the bracket on the explicit side (east → a "]")', async () => {
      await render('bpmn\n  comment note e "n"');
      const [b] = brackets();
      const p = pts(b);
      // A "]" starts and ends at the right edge (max x), turning in by the cap.
      const maxX = Math.max(...p.map(([x]) => x));
      expect(p[1][0]).toBe(maxX); // corner on the right edge
      expect(p[2][0]).toBe(maxX);
      expect(p[0][0]).toBeLessThan(maxX); // caps turn inward (left)
    });

    it('auto-picks the first port side for the bracket', async () => {
      await render('bpmn\n  comment note\n    port p n');
      const [b] = brackets();
      const p = pts(b);
      // A north bracket ("⊓"): both corners on the top edge (min y).
      const minY = Math.min(...p.map(([, y]) => y));
      expect(p[1][1]).toBe(minY);
      expect(p[2][1]).toBe(minY);
    });
  });

  describe('multi-line labels', () => {
    // Text lives inside a <g> for a leaf box, so walk the whole tree.
    const allText = (): El[] => {
      const out: El[] = [];
      const walk = (e: El): void => {
        if (e.nodeName === 'text') out.push(e);
        e.children.forEach(walk);
      };
      walk(svg);
      return out;
    };
    const tspans = (t: El): El[] => t.children.filter((c) => c.nodeName === 'tspan');

    // The DSL needs a literal backslash-n in the label; `\\n` in this JS string is
    // exactly that, which the parser turns into a caption newline.
    it('grows a leaf box by one line height per extra caption line', async () => {
      await render('bpmn\n  task a "First line\\nSecond line"');
      const [box] = findRect('bpmn-activity');
      // ACTIVITY_MIN_H (66) + one extra line (LABEL_LINE_H 16).
      expect(Number(box.attrs.height)).toBe(82);
    });

    it('draws a multi-line caption as one centred tspan per line', async () => {
      await render('bpmn\n  task a "First line\\nSecond line"');
      const label = allText().find((t) => tspans(t).length > 0);
      expect(label).toBeDefined();
      const rows = tspans(label as El);
      expect(rows.map((r) => r.textContent)).toEqual(['First line', 'Second line']);
      // Each row carries its own ABSOLUTE y (rather than a relative dy), so the block
      // holds its position independently of the parent <text>'s y: the first row sits
      // half a line above the centre the group was translated to, the next a full line
      // below it. Here the group's own origin is the local 0.
      const ys = rows.map((r) => Number(r.attrs.y));
      expect(ys[0]).toBe(-8);
      expect(ys[1]).toBe(8);
      // Both rows re-anchor x, since SVG would otherwise advance it past the last glyph.
      expect(rows[0].attrs.x).toBe(rows[1].attrs.x);
    });

    it('leaves a single-line caption as plain text (no tspans)', async () => {
      await render('bpmn\n  task a "One line"');
      const label = allText().find((t) => t.textContent === 'One line');
      expect(label).toBeDefined();
      expect(tspans(label as El).length).toBe(0);
    });

    it('collects a | multi-line label and grows the container band to fit it', async () => {
      await render(
        ['bpmn', '  subprocess Bob |', '      One', '      Two', '      Three', '    task Kid'].join('\n'),
      );
      const label = allText().find((t) => tspans(t).length === 3);
      expect(label).toBeDefined();
      expect(tspans(label as El).map((r) => r.textContent)).toEqual(['One', 'Two', 'Three']);
    });
  });

  it('draws a group as a round-cornered dashed box captioned with its name', async () => {
    await render(['bpmn LR', '  group Wrap', '    task A', '    task B'].join('\n'));
    const [group] = findRect('bpmn-group');
    expect(group).toBeDefined();
    // Carries the common outline, is a container (has children), and rounds its corners.
    expect(group.attrs.class).toContain('bpmn-entity');
    expect(group.attrs.class).toContain('bpmn-container');
    expect(Number(group.attrs.rx)).toBeGreaterThan(0);
    // Transparent interior so it never obscures the wrapped entities.
    expect(group.attrs.style).toContain('fill:transparent');
    // Its dash-dot border comes from the CSS class (not an inline dasharray).
    expect(group.attrs.style ?? '').not.toContain('stroke-dasharray');
    // The name is drawn as the caption (default). It sits in a <g> label band, so
    // walk the whole tree for it rather than scanning svg's direct children.
    const texts: El[] = [];
    const walk = (e: El): void => {
      if (e.nodeName === 'text') texts.push(e);
      e.children.forEach(walk);
    };
    walk(svg);
    expect(texts.some((t) => t.textContent === 'Wrap' && t.attrs.x !== '-9999')).toBe(true);
  });

});
