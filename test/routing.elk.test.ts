import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/db.js';
import { parser } from '../src/parser.js';
import { renderer } from '../src/render.js';

// Integration tests that run the REAL renderer (ELK layout + SVG build) under a
// minimal DOM stub. They cover only what the pure planRoute tests cannot: that a
// plan, once applied, actually routes through ELK â€” including the port chain
// climbing through a flattened container, which is the ELK behaviour the whole
// design hinges on â€” and that heads land correctly in the final geometry.
//
// The routing engine is diagram-agnostic, so the BPMN families here are stand-ins:
// `region` groups without drawing, `subprocess` is the container with children,
// `task` the leaf, and a `port` is the declared border anchor. What matters is the
// nesting and the per-container direction, not which shape gets drawn. The BPMN
// shape vocabulary itself is covered by `shapes.elk.test.ts`.

class El {
  nodeName: string;
  children: El[] = [];
  attrs: Record<string, string> = {};
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

// All edge <path> elements anywhere in the built SVG (edges are appended flat, each
// carrying the bpmn-edge class; other paths â€” arrowheads, glyphs â€” do not).
function edges(): El[] {
  return svg.children.filter(
    (e) => e.nodeName === 'path' && !!e.attrs.class?.includes('bpmn-edge'),
  );
}
// Count of edges carrying an arrowhead (a real line's single head).
function heads(): number {
  return edges().filter((p) => p.attrs['marker-start'] || p.attrs['marker-end']).length;
}
// Every element in the built SVG, recursively (for overlays nested under node groups).
function collectEls(): El[] {
  const out: El[] = [];
  const walk = (e: El): void => {
    out.push(e);
    e.children.forEach(walk);
  };
  svg.children.forEach(walk);
  return out;
}
// Every <rect> in the tree â€” used to count the debug overlay's port marks.
function allRects(): El[] {
  return collectEls().filter((e) => e.nodeName === 'rect');
}
// The debug overlay's ROUTER ports (red squares). A declared port carries the extra
// `bpmn-port-declared` class, so an exact class match picks out the router's own.
function routerPorts(): number {
  return allRects().filter((r) => r.attrs.class === 'bpmn-port').length;
}
// Hand-drawn bridges, which the debug overlay tints blue.
function blueBridges(): number {
  return edges().filter((p) => (p.attrs.style ?? '').includes('2962ff')).length;
}
// Finds a <marker> anywhere in the tree by an edge's url(#id) reference, so a test
// can tell WHICH marker an end carries (a hollow head, an origin circle, â€¦).
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

describe('routing (real ELK)', () => {
  it('routes a mixed-direction cross line via auto-depth port chains, one head at the target', async () => {
    await render(
      [
        'bpmn tb',
        '  layout elk',
        '  region Left lr',
        '    task A',
        '    task B',
        '  region Right tb',
        '    task C',
        '    task D',
        '  A --> C',
        '    route depth:1',
      ].join('\n'),
    );
    // `Left` (lr) differs from the root (tb) â†’ SEPARATE, so A chains out via one routed
    // port. `Right` (tb) shares the root flow â†’ INCLUDE/flat, so C needs no port. The
    // source chain + the ELK join = 2 polylines; exactly one head at the target.
    expect(edges().length).toBe(2);
    expect(heads()).toBe(1);
  });

  it('composes a flattened container with a port chain climbing out of it', async () => {
    // A -> S2 routes via flattening Big; B -> T's chain places a port on Bottom,
    // *inside* the flattened Big, and still routes. The pre-rewrite clamp existed
    // only because we (wrongly) thought this could not work â€” so this is the test
    // that must keep it working.
    await render(
      [
        'bpmn lr',
        '  layout elk',
        '  region Big tb',
        '    region Top tb',
        '      task A',
        '      task S',
        '    region Bottom tb',
        '      task B',
        '      task S2',
        '    A --> S2',
        '  region Other tb',
        '    task T',
        '  B --> T',
        '    route depth:1',
      ].join('\n'),
    );
    // Two real lines both route (one head each): A->S2 flattens Big; B->T chains out of
    // the flattened Big and reaches T. Directions are preserved throughout.
    expect(heads()).toBe(2);
    expect(edges().length).toBeGreaterThanOrEqual(3);
  });

  it('routes a two-level port chain out of nested containers without throwing', async () => {
    await render(
      [
        'bpmn tb',
        '  layout elk',
        '  region Outer lr',
        '    task P',
        '    region Inner tb',
        '      task A',
        '      task B',
        '  task C',
        '  A --> C',
        '    route exit:s depth:2',
      ].join('\n'),
    );
    // A sits two SEPARATE levels deep (Inner in Outer). Because the line exits Outer
    // through its container-child Inner, Outer's interior is WRAPPED. Inner is itself a
    // black-box, so A gets ONE port on Inner (its ELK edge A->Inner). Crossing the wrapper
    // for Outer reuses that same Inner port rather than stacking a second one on it â€” a
    // hand-drawn bridge Inner->Outer, then a port on Outer that ELK-joins C. So: the ELK
    // A->Inner segment, the bridge, and the ELK join = 3 polylines, one head. Routes
    // without throwing, and Inner carries exactly one port (no degenerate attach segment).
    expect(edges().length).toBe(3);
    expect(heads()).toBe(1);
  });

  it('does not double-port a wrapped black-box whose interior child is itself a black-box', async () => {
    // Root is LR, so `a` (tb) and `b` (lr) both differ from their parent AND branch â†’
    // both are black-boxes. `c---s` exits `a` through its container-child `b`, so `a`'s
    // interior is WRAPPED. `b` sits inside that wrapper but is itself a black-box, so the
    // line already ports `b` on its way out; crossing the wrapper for `a` must REUSE that
    // `b` port, not stack a second one on the same edge (the old bug: two ports on `b`
    // plus a zero-length attach segment). Expect exactly two router ports â€” one on `b`,
    // one on `a` â€” and no degenerate (zero-length) edge segment. `route depth:auto` is
    // explicit because auto-ports are opt-in (the default depth:0 is a pure bridge).
    // The bare `task`s are filler boxes: they make each container BRANCH, which is what
    // makes its differing direction visible and so a real boundary.
    await render(
      [
        'bpmn',
        '  layout elk',
        '  debug ports',
        '  route depth:auto',
        '  task s',
        '  subprocess a',
        '    task',
        '    direction tb',
        '    subprocess b',
        '      direction lr',
        '      task',
        '      task c',
        '        --- s',
      ].join('\n'),
    );
    expect(routerPorts()).toBe(2);
    // No edge segment collapses to a point (a duplicated boundary port would emit one).
    const hasDegenerate = edges().some((p) => {
      const nums = (p.attrs.d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
      for (let i = 0; i + 3 < nums.length; i += 2) {
        if (nums[i] === nums[i + 2] && nums[i + 1] === nums[i + 3]) return true;
      }
      return false;
    });
    expect(hasDegenerate).toBe(false);
  });

  it('bridges a declared port deep inside a wrapped black-box to a port on its own shell', async () => {
    // `W` (tb) differs from the root (lr) and branches â†’ a black-box. `nb` (lr) inside it
    // also differs and branches â†’ a NESTED black-box. `dp --- shp` runs from a declared
    // port on `nb` (deep inside `W`) to a declared port on `W`'s OWN shell; because the
    // line reaches into a container-child of `W`, `W`'s interior is WRAPPED. ELK cannot
    // route from inside a wrapper out to the shell that wraps it, so an ELK join silently
    // DROPS the line â€” the reported bug, where `dp --- shp` never appeared (0 edges). The
    // exposed-at-LCA check must spot the wrapper on `dp`'s path and BRIDGE instead, so the
    // line is drawn. Exactly one undirected line â†’ one polyline, no head.
    await render(
      [
        'bpmn',
        '  layout elk',
        '  debug ports',
        '  region W tb',
        '    region nb lr',
        '      task x',
        '      task y',
        '      port dp e',
        '        --- shp',
        '    port shp e',
        '  task out',
      ].join('\n'),
    );
    expect(edges().length).toBe(1); // was 0 before the fix (the line dropped)
    expect(heads()).toBe(0);
  });

  it('auto-ports on the INCLUDE child when exiting a wrapped black-box to its shell port', async () => {
    // `F` (tb) differs from the root (lr) and branches â†’ a wrapped black-box. `a` is its
    // INCLUDE child; `order` (lr) inside `a` is a nested black-box carrying a declared port
    // `po`. `po --- p1` runs from `po` (deep inside the wrapper) to `p1` on `F`'s own shell
    // (LCA is `F`). ELK cannot cross the wrapper, so the exit must ride an auto-port on the
    // wrapper's outermost INCLUDE child `a`: an ELK edge `po -> a`-port, then a single
    // bridge over the wrapper to `p1`. Before this cascade the line took ONE long direct
    // bridge with NO port (which reads wrong â€” the port belongs on `a`'s edge). Assert
    // exactly one router port (on `a`) and the two polylines.
    await render(
      [
        'bpmn',
        '  layout elk',
        '  debug ports',
        '  route depth:auto',
        '  region F tb',
        '    subprocess a',
        '      task',
        '      region r',
        '        subprocess order lr',
        '          task',
        '          task of',
        '          port po e',
        '            --- p1',
        '    port p1 e',
      ].join('\n'),
    );
    expect(routerPorts()).toBe(1); // the auto-port on `a`; was 0 (a portless bridge) before
    expect(edges().length).toBe(2); // po -> a (ELK) + a -> p1 (wrapper bridge)
  });

  it('ELK-joins to a declared port on an INCLUDE sibling â€” no needless bridge', async () => {
    // `deep` sits in `SEP` (tb) â€” a black-box, so `deep---pi` chains out to an auto-port on
    // `SEP`. Its other end `pi` is a declared port on `INC` (lr, same flow as the root â†’ an
    // INCLUDE sibling). The join `SEP-port -> pi` crosses NO wrapper â€” both are ports on
    // direct children of the flat root â€” so ELK routes it. The exposed-at-LCA check must NOT
    // reject `pi` merely because `INC` is INCLUDE (a declared port on an intermediate INCLUDE
    // node is a real, reachable anchor); otherwise the join needlessly becomes a hand-drawn
    // bridge. Assert the join is ELK: no blue (valid-bridge) edge under debug ports.
    await render(
      [
        'bpmn',
        '  layout elk',
        '  debug ports',
        '  route depth:auto',
        '  region SEP tb',
        '    task deep',
        '      --- pi',
        '    task s2',
        '  region INC lr',
        '    port pi w',
        '    task i1',
        '    task i2',
      ].join('\n'),
    );
    expect(blueBridges()).toBe(0); // was 1 (the join bridged) before the fix
    expect(edges().length).toBe(2); // deep -> SEP-port (chain) + SEP-port -> pi (ELK join)
  });

  it('flattens through to a declared port nested below the LCA without throwing', async () => {
    // `alice` is a declared port on `region Inner`, itself inside `extra` â€” one level
    // below the root LCA. In the flatten-by-default model every container on the path
    // is INCLUDE (`Inner` is a single-box-child shell that collapses; `extra` and
    // a-bob's region share the root's tb flow), so a-bob---alice FLATTENS to a plain
    // ELK edge that reaches the boundary port directly â€” it grows NO routing ports.
    // Regression that the nested declared port still routes (no throw, no dropped line).
    await render(
      [
        'bpmn tb',
        '  layout elk',
        '  debug ports',
        '  route depth:99',
        '  region',
        '    task a-bob',
        '      --- alice',
        '  region extra',
        '    region Inner lr',
        '      port alice w',
        '        --- a-alice',
        '      task a-alice',
      ].join('\n'),
    );
    const ports = allRects().filter((r) => (r.attrs.class ?? '').startsWith('bpmn-port'));
    const declared = ports.filter((r) => r.attrs.class?.includes('bpmn-port-declared')).length;
    // One declared port (alice) and NO router ports: the whole path flattens, so the
    // line ELK-routes to the boundary port without growing any port chain of its own.
    expect(declared).toBe(1);
    expect(routerPorts()).toBe(0);
  });

  it('hand-routes the whole line at depth:0 (single polyline, one head)', async () => {
    await render(
      [
        'bpmn tb',
        '  layout elk',
        '  region Left lr',
        '    task A',
        '    task B',
        '  region Right tb',
        '    task C',
        '    task D',
        '  A --> C',
        '    route depth:0',
      ].join('\n'),
    );
    expect(edges().length).toBe(1);
    expect(heads()).toBe(1);
  });

  it('routes an undirected line through a bridging port as a valid (non-red) edge', async () => {
    await render(
      [
        'bpmn lr',
        '  layout elk',
        '  task DB',
        '  subprocess Box',
        '    task Inner',
        '    port In w',
        '    Inner --- In',
        '  DB --- In',
      ].join('\n'),
    );
    const ls = edges();
    expect(ls.length).toBe(2);
    expect(ls.every((p) => p.attrs.class === 'bpmn-edge')).toBe(true);
  });

  it('keeps a box whose only child is a port (it is a leaf, not an empty container)', async () => {
    // Regression: a container activity whose only child is a `port` was built as a
    // compound node with no child boxes, which ELK collapsed to zero size â€” the box
    // vanished, leaving just its label. Both activities must render as normal leaf
    // boxes, one of them carrying the port.
    await render(
      ['bpmn lr',
        '  layout elk', '  subprocess Bob', '    port p w', '  task Alice', '  p --- Alice'].join('\n'),
    );
    const boxes = allRects().filter((e) => e.attrs.class?.includes('bpmn-activity'));
    expect(boxes.length).toBe(2);
    for (const b of boxes) {
      expect(Number(b.attrs.width)).toBeGreaterThan(0);
      expect(Number(b.attrs.height)).toBeGreaterThan(0);
      // Being leaves now, neither is tagged as a container.
      expect(b.attrs.class).not.toContain('bpmn-container');
    }
    // The port line still routes as one valid polyline.
    const ls = edges();
    expect(ls.length).toBe(1);
    expect(ls[0].attrs.class).toBe('bpmn-edge');
  });

  it('wires a child to its container port and the port on to a sibling', async () => {
    await render(
      [
        'bpmn lr',
        '  layout elk',
        '  subprocess Box',
        '    task Inner',
        '    port Out e',
        '  task DB',
        '  Inner --- Out',
        '  Out --> DB',
      ].join('\n'),
    );
    // Two valid edges; the head sits on DB (away from the port), never on Out.
    expect(edges().length).toBe(2);
    expect(edges().every((p) => p.attrs.class === 'bpmn-edge')).toBe(true);
    expect(heads()).toBe(1);
  });

  it('routes a two-port pass-through between sibling containers', async () => {
    // Worker â€” Out â€” In â€” Item: each port is a pass-through anchor, so all three
    // undirected segments route and none is flagged (no head lands on a port).
    await render(
      [
        'bpmn lr',
        '  layout elk',
        '  subprocess Box',
        '    task Worker',
        '    port Out e',
        '    Worker --- Out',
        '  subprocess Store',
        '    task Item',
        '    port In w',
        '    Item --- In',
        '  Out --- In',
      ].join('\n'),
    );
    const ls = edges();
    expect(ls.length).toBe(3);
    expect(ls.every((p) => p.attrs.class === 'bpmn-edge')).toBe(true);
  });

  it('draws an arrowhead into a port as an ordinary edge', async () => {
    // Lines are not validated: a head landing on a port draws like any other line.
    await render(
      ['bpmn lr',
        '  layout elk', '  task DB', '  subprocess Box', '    port In w', '  DB --> In'].join('\n'),
    );
    const ls = edges();
    expect(ls.length).toBe(1);
    expect(ls[0].attrs.class).toBe('bpmn-edge');
    expect(heads()).toBe(1);
  });

  it('draws declared ports green under the debug overlay', async () => {
    await render(
      [
        'bpmn lr',
        '  layout elk',
        '  debug ports',
        '  task DB',
        '  subprocess Box',
        '    task Inner',
        '    port In w',
        '    Inner --- In',
        '  DB --- In',
      ].join('\n'),
    );
    const marks = allRects().filter((e) => (e.attrs.class ?? '').startsWith('bpmn-port'));
    expect(marks.length).toBe(1);
    expect(marks[0].attrs.class).toContain('bpmn-port-declared');
    expect(marks[0].attrs.style).toContain('#00c853');
  });

  // A mixed-direction crossing (root is lr, L is tb, R is lr) with `route depth:0`
  // routes A1-->B1 as a single hand-drawn bridge (depth:0 opts out of the port chain).
  // Under the debug overlay that bridge is tinted blue so it reads apart from
  // ELK-routed edges; without the overlay it keeps its default.
  const mixedBridgeDiagram = (debug: boolean): string =>
    [
      'bpmn lr',
        '  layout elk',
      ...(debug ? ['  debug ports'] : []),
      '  region L tb',
      '    task A1',
      '    task A2',
      '  region R lr',
      '    task B1',
      '    task B2',
      '  A1 --> B1',
      '    route depth:0',
    ].join('\n');

  it('tints manual bridges blue under the debug overlay', async () => {
    await render(mixedBridgeDiagram(true));
    const ls = edges();
    expect(ls.length).toBe(1);
    expect(ls[0].attrs.style).toBe('stroke:#2962ff');
  });

  it('leaves manual bridges their default color without the debug overlay', async () => {
    await render(mixedBridgeDiagram(false));
    const ls = edges();
    expect(ls.length).toBe(1);
    expect(ls[0].attrs.style ?? '').not.toContain('#2962ff');
  });

  // The reported bug: `alice` sits inside a region, wired to a port on a *sibling*
  // region. The line lives in the root LCA but alice is a level down, so a plain
  // ELK edge could not dive across that boundary and the line was silently
  // dropped. It now routes through the ordinary crossing machinery.
  const nestedPortDiagram = [
    'bpmn tb',
        '  layout elk',
    '  region',
    '    task alice',
    '      --- p-bob',
    '  region lr',
    '    port p-bob w',
    '      --- bob',
    '    task bob',
    '    task bob2',
  ].join('\n');

  it('routes a line to a declared port whose other end is nested in a sibling container', async () => {
    await render(nestedPortDiagram);
    // alice---p-bob FLATTENS to a single ELK edge: the root flattens and the lr region is
    // black-boxed (it branches into bob/bob2), so its boundary port p-bob shows through and
    // the edge reaches it directly â€” no chain, no bridge. The region's own p-bob---bob line
    // is the second polyline. The alice line is no longer dropped.
    expect(edges().length).toBe(2);
    // Both route cleanly, so neither is red.
    expect(edges().every((p) => p.attrs.class === 'bpmn-edge')).toBe(true);
  });

  it("preserves a sibling container's own direction when routing a nested port line", async () => {
    // The crossing must NOT flatten the mixed root (which would unify directions).
    // The right region flows LR, so `bob` stays to the RIGHT of the west port it
    // connects to â€” a horizontal segment â€” rather than being stacked by a TB flow.
    await render(nestedPortDiagram);
    const horizontal = edges().some((p) => {
      const pts = [...p.attrs.d.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map((m) => [
        Number(m[1]),
        Number(m[2]),
      ]);
      return pts.length >= 2 && pts.every((q) => q[1] === pts[0][1]);
    });
    expect(horizontal).toBe(true);
  });

  it('flattens the LCA parent for a deep line to a port ON the LCA, instead of throwing', async () => {
    // Regression: `c` is nested two levels under `a`, and port `p` sits ON `a`
    // (the LCA). A straight flatten of `a` asks ELK to route deep-node â†’ a port on
    // the flatten-root, which throws UnsupportedGraphException. planRoute raises the
    // flatten to `a`'s parent `x`, so `a` is an intermediate node and the edge
    // routes. Reaching these assertions at all proves the render no longer throws.
    await render(
      [
        'bpmn',
       '  layout elk',
       '  subprocess x',
        '    subprocess a',
        '      subprocess b',
        '        task c',
        '          --- p',
        '      port p e',
      ].join('\n'),
    );
    // The one line routed as a single (flattened) ELK edge â€” not dropped, not crashed.
    expect(edges().length).toBe(1);
  });

  it('black-boxes an off-spine differing container so a flatten keeps its direction', async () => {
    // c -> p (port on a) flattens a's parent x. x's subtree also holds d (tb), off
    // the spine â€” flattening x would rotate d, so d is black-boxed (SEPARATE_CHILDREN)
    // and keeps its tb while the rest flattens. One ELK edge, no throw, d still tb.
    await render(
      [
        'bpmn',
        '  layout elk',
        '  subprocess x',
        '    subprocess a',
        '      subprocess b',
        '        task c',
        '          --- p',
        '        subprocess d',
        '          direction tb',
        '          data dc',
        '          data dp',
        '      port p e',
      ].join('\n'),
    );
    expect(edges().length).toBe(1);
    // The two data objects are the only polygons carrying `bpmn-data` (their fold is a
    // polyline, so it never collides with this).
    const dataBoxes = collectEls().filter(
      (e) => e.nodeName === 'polygon' && (e.attrs.class ?? '').includes('bpmn-data'),
    );
    expect(dataBoxes.length).toBe(2);
    // A polygon's first point is its top-left corner, which is enough to compare the
    // two boxes' placement.
    const corner = (e: El): [number, number] => {
      const [x, y] = e.attrs.points.trim().split(/\s+/)[0].split(',').map(Number);
      return [x, y];
    };
    const [ax, ay] = corner(dataBoxes[0]);
    const [bx, by] = corner(dataBoxes[1]);
    // d is tb, so its two data objects stack VERTICALLY (a vertical gap larger than any
    // horizontal one). Had d been flattened into x's LR they would be side by side.
    expect(Math.abs(ay - by)).toBeGreaterThan(Math.abs(ax - bx));
  });

  it('routes a black-boxed interior, wrapping w so p2 exits over a single bridge', async () => {
    // `c -> p1` flattens the root and black-boxes the tb `w`. Because `p2 -> sink`
    // exits `w` through its container-child `x`, `w`'s uniform interior is WRAPPED: the
    // interior `z -> p2` ELK-routes through the flattened interior, and `p2 -> sink`
    // exits with a port on `x`, one hand-drawn BRIDGE over the wrapper, and a port on
    // `w`'s edge (exposed through the flattened `b`/`a`). One wrapper, one bridge.
    await render(
      [
        'bpmn',
        '  layout elk',
        '  debug ports',
        '  route depth:auto',
        '  subprocess a',
        '    task',
        '    port p1 e',
        '    subprocess b',
        '      task c',
        '        --- p1',
        '      subprocess w',
        '        direction tb',
        '        subprocess x',
        '          task',
        '          port p2 e',
        '          subprocess y',
        '            task z',
        '              --- p2',
        '  task sink',
        '    p1 ---',
        '    p2 ---',
      ].join('\n'),
    );
    // Four lines â†’ 5 edges: c---p1, z---p2, p1---sink, and p2---sink's wrapper exit
    // (an ELK span + a bridge over the wrapper). Exactly one blue hand-drawn bridge.
    const wrappers = collectEls().filter((e) => e.attrs.class === 'bpmn-debug-wrapper').length;
    expect(edges().length).toBe(5);
    expect(blueBridges()).toBe(1);
    expect(wrappers).toBe(1);
  });

  it('wraps a deep uniform black-box interior: z---s exits with 2 ports + 1 bridge', async () => {
    // c---s flattens the root and black-boxes the tb `w`. `z` is 2 uniform levels (x, y)
    // deep inside `w`, so `w`'s interior is FLATTENED by a synthetic wrapper: z---s exits
    // with one port on `w`'s direct child (one ELK edge through the flattened interior),
    // a single hand-drawn BRIDGE over the wrapper, and a port on `w` â€” 2 ports, 1 bridge,
    // vs the old 3-port chain. `w---s` is a plain exposed edge; `c---s` flattens.
    await render(
      [
        'bpmn',
        '  layout elk',
        '  debug ports',
        '  route depth:auto',
        '  subprocess a',
        '    task',
        '    subprocess b',
        '      task c',
        '      subprocess w',
        '        direction tb',
        '        subprocess x',
        '          task',
        '          subprocess y',
        '            task z',
        '  task s',
        '    c ---',
        '    z ---',
        '    w ---',
      ].join('\n'),
    );
    const wrappers = collectEls().filter((e) => e.attrs.class === 'bpmn-debug-wrapper').length;
    expect(edges().length).toBe(5); // c---s (1) + z---s cascade (3) + w---s (1)
    expect(blueBridges()).toBe(1); // the single wrapper crossing
    expect(wrappers).toBe(1); // one synthetic INCLUDE wrapper region (magenta)
  });

  it('renders a declared port inside a wrapped black-box interior without throwing', async () => {
    // `z---s` (2 levels deep) wraps `w`. `x` also carries a declared port `px` used by
    // `px---s` â€” a port on a container that the wrapper flattens (an intermediate INCLUDE
    // node, whose port stays valid). This must still route, not throw or drop.
    await render(
      [
        'bpmn',
       '  layout elk',
       '  subprocess a',
        '    task',
        '    subprocess b',
        '      task c',
        '      subprocess w',
        '        direction tb',
        '        subprocess x',
        '          port px e',
        '          subprocess y',
        '            task z',
        '  task s',
        '    c ---',
        '    z ---',
        '    px ---',
      ].join('\n'),
    );
    // All three lines produce a drawn edge; nothing throws.
    expect(edges().length).toBeGreaterThanOrEqual(3);
  });

  it('routes every port line of a wrapped tb region â€” one bridge for the deep exit', async () => {
    // The p3-example: `c -> p1` and `p3 -> sink` flatten the root and black-box `w`;
    // `z -> p2` routes inside `w`, and `p3 -> sink` exits through `w`'s exposed edge.
    // `w`'s uniform interior is WRAPPED (a line exits it via a container-child), so the
    // deep `p2 -> sink` exit cascades over a single hand-drawn bridge. Adding `p3`
    // demotes nothing; everything else ELK-routes.
    await render(
      [
        'bpmn',
        '  layout elk',
        '  debug ports',
        '  route depth:auto',
        '  subprocess a',
        '    task',
        '    port p1 e',
        '    subprocess b',
        '      task c',
        '        --- p1',
        '      subprocess w',
        '        direction tb',
        '        subprocess x',
        '          task',
        '          port p2 e',
        '          subprocess y',
        '            task z',
        '              --- p2',
        '        port p3 e',
        '  task sink',
        '    p1 ---',
        '    p2 ---',
        '    p3 ---',
      ].join('\n'),
    );
    expect(edges().length).toBe(6);
    expect(blueBridges()).toBe(1); // the single wrapper crossing for p2 -> sink's deep exit
  });

  it('caps a depth:2 chain, still wrapping w so the deep exit rides one bridge', async () => {
    // The p3-example again, but p2 -> sink carries `route depth:2`. `w` is still
    // WRAPPED (a line exits its container-child), so the deep exit cascades over one
    // hand-drawn bridge regardless of the depth cap â€” depth:2 is indistinguishable from
    // auto here. One blue bridge; every other line ELK-routes.
    await render(
      [
        'bpmn',
       '  layout elk',
       '  debug ports',
       '  subprocess a',
        '    task',
        '    port p1 e',
        '    subprocess b',
        '      task c',
        '        --- p1',
        '      subprocess w',
        '        direction tb',
        '        subprocess x',
        '          task',
        '          port p2 e',
        '          subprocess y',
        '            task z',
        '              --- p2',
        '        port p3 e',
        '  task sink',
        '    p1 ---',
        '    p2 ---',
        '      route depth:2',
        '    p3 ---',
      ].join('\n'),
    );
    expect(edges().length).toBe(6);
    expect(blueBridges()).toBe(1); // p2 -> sink's deep exit still rides the wrapper bridge
  });

  it('demotes one blocking flatten; the demoted line exits over the wrapper bridge', async () => {
    // Same as above but WITHOUT the z -> p2 interior line. Three flattens contend:
    // c->p1 and p3->sink need `w` SEPARATE (they black-box it) while p2->sink wants `w`
    // INCLUDE on its corridor. The conflict graph is a star centred on p2->sink â€”
    // demoting that ONE line frees both others (not the two leaves). `w`'s uniform
    // interior is WRAPPED (the demoted p2->sink exits via container-child x), so the
    // demoted line cascades OUT over one hand-drawn bridge; everything else ELK-routes.
    await render(
      [
        'bpmn',
        '  layout elk',
        '  debug ports',
        '  route depth:auto',
        '  subprocess a',
        '    task',
        '    port p1 e',
        '    subprocess b',
        '      task c',
        '        --- p1',
        '      subprocess w',
        '        direction tb',
        '        subprocess x',
        '          task',
        '          port p2 e',
        '          subprocess y',
        '            task z',
        '        port p3 e',
        '  task sink',
        '    p1 ---',
        '    p2 ---',
        '    p3 ---',
      ].join('\n'),
    );
    expect(edges().length).toBe(5);
    expect(blueBridges()).toBe(1); // p2->sink bridges; c->p1 and p3->sink flatten
  });

  it('routes a deep interior line into the wrapped box own port via a bridge', async () => {
    // x (tb) is the SEPARATE black-box; its uniform interior is wrapped. p2 is a port ON
    // x's own boundary. p2->sink is exposed through the flattened b/a and ELK-routes
    // (no bridge). The deep interior line z->p2 goes from inside x's wrapper to x's OWN
    // shell port (x is the LCA). ELK cannot route across the wrapper, so z gets an
    // auto-port on `y` â€” x's outermost INCLUDE child â€” reaches it in one ELK edge, then a
    // single hand-drawn BRIDGE crosses the wrapper to p2. c->p1 and p1->sink flatten. So
    // 5 edges (z->y ELK edge + wrapper bridge among them), one blue bridge; nothing dropped.
    await render(
      [
        'bpmn',
        '  layout elk',
        '  debug ports',
        '  route depth:auto',
        '  subprocess a',
        '    task',
        '    port p1 e',
        '    subprocess b',
        '      task c',
        '        --- p1',
        '      subprocess x',
        '        direction tb',
        '        task',
        '        port p2 e',
        '        subprocess y',
        '          task z',
        '            --- p2',
        '  task sink',
        '    p1 ---',
        '    p2 ---',
      ].join('\n'),
    );
    expect(edges().length).toBe(5); // c->p1, p1->sink, p2->sink, z->y (ELK), y->p2 (bridge)
    expect(blueBridges()).toBe(1); // z->p2 crosses the wrapper as a single hand-drawn bridge
  });

  it('treats depth:0 as the default and depth:9999 as equivalent to depth:auto', async () => {
    // `depth` is only an autoport BUDGET, spent when a line cannot flatten. The DEFAULT is
    // depth:0 â€” no budget at all, so an unflattenable crossing is a pure hand-drawn
    // bridge â€” and `depth:auto` is the opt-in that grants an unlimited budget. Two
    // equivalence classes, checked on the fully drawn geometry rather than mere counts:
    //   depth:0 â‰¡ no route      (0 is the default)
    //   depth:9999 â‰¡ depth:auto (any budget past the nesting depth is unlimited)
    // and the two classes must DIFFER â€” otherwise `depth:auto` would not be doing anything.
    const body = [
      '  subprocess a',
      '    task',
      '    subprocess b',
      '      task c',
      '      subprocess w',
      '        direction tb',
      '        subprocess x',
      '          task',
      '          subprocess y',
      '            task z',
      '  task s',
      '    c ---',
      '    z ---',
      '    w ---',
    ];
    const geom = async (header: string[]): Promise<string> => {
      await render(['bpmn', '  layout elk', ...header, ...body].join('\n'));
      return edges()
        .map((p) => p.attrs.d)
        .sort()
        .join('|');
    };
    const plain = await geom([]);
    const zero = await geom(['  route depth:0']);
    const auto = await geom(['  route depth:auto']);
    const big = await geom(['  route depth:9999']);
    expect(zero).toBe(plain);
    expect(big).toBe(auto);
    expect(auto).not.toBe(plain);
  });

  it('renders an undirected mixed cross line with no head', async () => {
    await render(
      [
        'bpmn tb',
        '  layout elk',
        '  region Left lr',
        '    task A',
        '    task B',
        '  region Right tb',
        '    task C',
        '    task D',
        '  A --- C',
        '    route depth:1',
      ].join('\n'),
    );
    // Undirected, so no head. `Left` (lr) is SEPARATE â†’ A chains out via one port;
    // `Right` (tb) shares the root flow â†’ INCLUDE, so C needs none: 2 polylines.
    expect(heads()).toBe(0);
    expect(edges().length).toBe(2);
  });

  it('routes a complex line through nested west ports without throwing', async () => {
    // `p` (w) and `p1` (w) are both west ports. `x` (tb) is a black-box; the `region` (lr)
    // inside it is a nested black-box, and `p---p1` reaching into it wraps `x`'s interior.
    // `p---p1` runs from `p` on `x`'s OWN shell to `p1` deep on `s1` inside the wrapper
    // (LCA is `x`): it ports the `region` boundary it crosses, reaches it via an ELK edge,
    // then BRIDGES over the wrapper to `p`. So a---p (ELK) + p1->region (ELK) +
    // region->p (bridge) = 3 valid, non-red edges; routes cleanly, no throw. NOTE: `s1`
    // sits flush against `region`'s west edge, so its declared port `p1` and the auto-port
    // on `region` nearly coincide â€” the p1->region attach segment renders near-degenerate
    // (a geometric quirk of the flush west edges, not a routing error).
    await render(
      [
        'bpmn',
        '  layout elk',
        '  route depth:auto',
        '  task a',
        '  subprocess x',
        '   direction tb',
        '   region lr',
        '     subprocess s1',
        '       port p1 w',
        '     task s2',
        '   port p w',
        '  a --- p --- p1',
      ].join('\n'),
    );
    expect(edges().length).toBe(3);
    expect(edges().every((p) => p.attrs.class === 'bpmn-edge')).toBe(true);
  });

  // ---- swimlanes ----------------------------------------------------------
  //
  // A pool is ALWAYS a black-box and a branching lane normally becomes one too, so a
  // line reaching into a swimlane is chained or bridged rather than flattening it.
  // That is load-bearing for two separate reasons â€” the lane's direction, and the
  // pool's geometry â€” so both get a test.

  it("keeps a lane's own flow direction when a line crosses out of it", async () => {
    // Pool P flows LR, so it stacks its lanes across that (TB) while each lane runs LR.
    // `A --> D` crosses from L1 into L2, with the pool as the LCA. Flattening the pool to
    // route it would impose the pool's TB on L1 and stack A above B; L1 branches (2 box
    // children) so it must stay a black-box and keep its LR instead.
    await render(
      [
        'bpmn lr',
        '  layout elk',
        '  pool P',
        '    lane L1',
        '      task A',
        '      task B',
        '      A --> B',
        '    lane L2',
        '      data D',
        '      A --> D',
      ].join('\n'),
    );
    // A and B are the only activities, so the two activity rects are exactly them.
    const boxes = allRects().filter((e) => (e.attrs.class ?? '').includes('bpmn-activity'));
    expect(boxes.length).toBe(2);
    const dx = Math.abs(Number(boxes[0].attrs.x) - Number(boxes[1].attrs.x));
    const dy = Math.abs(Number(boxes[0].attrs.y) - Number(boxes[1].attrs.y));
    expect(dx).toBeGreaterThan(dy); // side by side (LR), not stacked (TB)
  });

  it('keeps a one-lane pool and an empty pool intact alongside a crossing line', async () => {
    // The degenerate swimlane shapes, which the black-box rule must not disturb: a pool
    // with a SINGLE lane (the lane is a collapsible shell, so normalization pushes its
    // direction down) and a pool with NO lanes at all (a leaf box, which has no hierarchy
    // to handle). Both must still render at a real size with the crossing line drawn.
    await render(
      [
        'bpmn lr',
        '  layout elk',
        '  pool Solo',
        '    lane OnlyOne',
        '      task A',
        '  pool Empty',
        '  A --> Empty',
      ].join('\n'),
    );
    const pools = allRects().filter((e) => (e.attrs.class ?? '').includes('bpmn-pool'));
    expect(pools.length).toBe(2);
    for (const p of pools) {
      expect(Number(p.attrs.width)).toBeGreaterThan(0);
      expect(Number(p.attrs.height)).toBeGreaterThan(0);
    }
    // The cross-pool line is drawn, and as a message flow (dashed).
    expect(edges().length).toBeGreaterThanOrEqual(1);
    expect(edges().some((p) => (p.attrs.class ?? '').includes('bpmn-message-flow'))).toBe(true);
  });

  it('puts a message flow origin circle and slash on exactly one segment of a chained route', async () => {
    // A cross-pool line is a message flow: dashed, a hollow head at the target and a small
    // open circle at its ORIGIN. With `depth:auto` the line becomes a CHAIN of several
    // segments (ports out of the lane and the pool on each side, plus an ELK join), and
    // each end decoration belongs to exactly one geometric endpoint â€” so exactly one
    // segment may draw the circle, one the head, and one the leading `/` slash. Getting
    // this wrong smears a marker across every segment of the line.
    await render(
      [
        'bpmn lr',
        '  layout elk',
        '  pool P1',
        '    lane L1',
        '      task A',
        '      task A2',
        '  pool P2',
        '    lane L2',
        '      task B',
        '      task B2',
        '  A /--> B',
        '    route depth:auto',
      ].join('\n'),
    );
    const flows = edges().filter((p) => (p.attrs.class ?? '').includes('bpmn-message-flow'));
    // The line really did split into a chain (otherwise this proves nothing).
    expect(flows.length).toBeGreaterThan(1);
    // Both decorations ride a `marker-start`: a chain's touch segment runs
    // endpoint -> port, so the endpoint is that polyline's START. They are told apart by
    // what the marker holds â€” a <circle> for the origin, a <path> for the hollow head.
    const marks = (p: El): El[] =>
      [markerByRef(p.attrs['marker-start']), markerByRef(p.attrs['marker-end'])].filter(
        (m): m is El => !!m,
      );
    const carries = (p: El, tag: string): boolean =>
      marks(p).some((m) => m.children.some((c) => c.nodeName === tag));
    expect(flows.filter((p) => carries(p, 'circle')).length).toBe(1);
    expect(flows.filter((p) => carries(p, 'path')).length).toBe(1);
    // â€¦and never both on one segment: each end belongs to its own side of the line.
    expect(flows.findIndex((p) => carries(p, 'circle'))).not.toBe(
      flows.findIndex((p) => carries(p, 'path')),
    );
    // Exactly one slash tick, from the single leading `/`.
    const slashes = collectEls().filter((e) => e.attrs.class === 'bpmn-edge-slash');
    expect(slashes.length).toBe(1);
  });

  it("draws the arrowhead at the endpoint, not the wrapper shell, when the endpoint IS the wrapper's outer child", async () => {
    // `W` (tb) differs from the root (lr) and branches (2 container children: region Alpha,
    // subprocess Beta) â†’ a black-box. The internal line `leaf1 --- leafR` crosses between
    // Alpha and Beta (both container-children of W), so W's interior is WRAPPED.
    // `Source --> Beta` then targets Beta itself â€” Beta *is* the wrapper's outer child, with
    // nothing deeper â€” so per the `wrapped.has(C)` cascade, Beta's side produces ONLY a
    // hand-drawn bridge (Beta's box -> a port on W's shell), no ELK segment. That bridge is
    // the side's sole touch element and must carry the arrowhead; before the fix it always
    // landed on the ELK join instead (at the shell port), so the head rendered at W's
    // boundary instead of at Beta.
    await render(
      [
        'bpmn lr',
        '  layout elk',
        '  task Source',
        '  region W tb',
        '    region Alpha',
        '      task leaf1',
        '        --- leafR',
        '    subprocess Beta',
        '      task leafR',
        '  Source --> Beta',
      ].join('\n'),
    );
    // Beta is an activity CONTAINER (unlike `region`, its drawn box is not cosmetically
    // expanded to tile its parent â€” see bpmnStyle's drawNode), so its rect is exactly its
    // real anchor geometry. It is the only activity that is also a container.
    const betaRect = collectEls().find(
      (e) =>
        e.nodeName === 'rect' &&
        (e.attrs.class ?? '').includes('bpmn-activity') &&
        (e.attrs.class ?? '').includes('bpmn-container'),
    )!;
    expect(betaRect).toBeDefined();
    const bx = Number(betaRect.attrs.x);
    const by = Number(betaRect.attrs.y);
    const bh = Number(betaRect.attrs.height);
    const headed = edges().find((p) => p.attrs['marker-start'] || p.attrs['marker-end']);
    expect(headed).toBeDefined();
    const nums = (headed!.attrs.d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
    const atStart = !!headed!.attrs['marker-start'];
    const [hx, hy] = atStart ? [nums[0], nums[1]] : [nums[nums.length - 2], nums[nums.length - 1]];
    // The head must sit on Beta's own boundary (its west edge, since Source enters from the
    // left) â€” not on W's outer shell further to the right.
    expect(hx).toBeCloseTo(bx, 0);
    expect(hy).toBeGreaterThanOrEqual(by - 0.5);
    expect(hy).toBeLessThanOrEqual(by + bh + 0.5);
  });

  it('routes a line between ports declared on two leaf entities', async () => {
    // A port may hang off ANY entity, not just a container — an event and a task here.
    await render(
      [
        'bpmn',
        '  debug ports',
        '  start',
        '    port p1 s',
        '  task {',
        '    port p2 n',
        '  }',
        '  p1 --> p2',
      ].join('\n'),
    );
    expect(edges()).toHaveLength(1);
    expect(edges()[0].attrs.class).toBe('bpmn-edge');
    expect(heads()).toBe(1);
    // Both declared ports are drawn.
    const declared = allRects().filter((r) => (r.attrs.class ?? '').includes('bpmn-port-declared'));
    expect(declared).toHaveLength(2);
  });

  it('re-aims auto port sides at the pool order ELK produced, not the declaration order', async () => {
    // A, B and an unnamed pool are declared in that order, but ELK stacks them B, pool, A.
    // Without the post-layout correction the auto sides follow the DECLARATION order, so
    // every port faces away from its partner and the lines loop around the diagram.
    await render(
      [
        'bpmn',
        '  debug ports',
        '  route depth:?',
        '  pool A',
        '  pool B',
        '  pool',
        '    lane',
        '      task C',
        '  B --> A',
        '  C --> A',
      ].join('\n'),
    );
    const pools = allRects()
      .filter((r) => (r.attrs.class ?? '').includes('bpmn-pool'))
      .map((r) => ({
        top: Number(r.attrs.y),
        bottom: Number(r.attrs.y) + Number(r.attrs.height),
      }))
      .sort((a, b) => a.top - b.top);
    expect(pools).toHaveLength(3);
    const [top, mid, bottom] = pools;

    // Router ports, by the edge they sit on.
    const portYs = allRects()
      .filter((r) => r.attrs.class === 'bpmn-port')
      .map((r) => Number(r.attrs.y) + Number(r.attrs.height) / 2);
    const on = (y: number): number => portYs.filter((p) => Math.abs(p - y) < 2).length;

    // Everything flows downwards: the two upper pools exit south, the bottom pool (A) is
    // entered twice from the north. Nothing sits on the far edges.
    expect(on(top.bottom)).toBe(1);
    expect(on(top.top)).toBe(0);
    expect(on(mid.bottom)).toBe(2); // the pool's shell port and the lane's, stacked
    expect(on(mid.top)).toBe(0);
    expect(on(bottom.top)).toBe(2);
    expect(on(bottom.bottom)).toBe(0);

    // And no edge detours above or below the pool stack.
    for (const p of edges()) {
      const nums = (p.attrs.d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
      for (let i = 1; i < nums.length; i += 2) {
        expect(nums[i]).toBeGreaterThanOrEqual(top.top - 1);
        expect(nums[i]).toBeLessThanOrEqual(bottom.bottom + 1);
      }
    }
  });
});




