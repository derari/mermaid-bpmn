import { describe, expect, it } from 'vitest';
import type { Direction, RouteSpec } from '../src/db.js';
import {
  type DirNode,
  analyzeFlatten,
  branchIndexUnderLca,
  branchUnderLca,
  enclosingContainers,
  laterFromGeometry,
  normalizeDirections,
  parentId,
  planRoute,
  resolveEnterSide,
  resolveExitSide,
  segCount,
  sideFromFlow,
} from '../src/layout/routePlan.js';

describe('routePlan helpers', () => {
  describe('parentId', () => {
    it('drops the last dot segment; top-level maps to root ("")', () => {
      expect(parentId('n0.1.2')).toBe('n0.1');
      expect(parentId('n0.1')).toBe('n0');
      expect(parentId('n0')).toBe('');
      expect(parentId('')).toBe('');
    });
  });

  describe('segCount', () => {
    it('counts container levels; root is 0', () => {
      expect(segCount('')).toBe(0);
      expect(segCount('n0')).toBe(1);
      expect(segCount('n0.1')).toBe(2);
      expect(segCount('n0.1.2')).toBe(3);
    });
  });

  describe('branchIndexUnderLca', () => {
    it('reads the branch index at the child-of-lca position', () => {
      expect(branchIndexUnderLca('n2.1', '')).toBe(2); // top-level branch n2
      expect(branchIndexUnderLca('n0.3.1', 'n0')).toBe(3); // child of n0 is index 3
      expect(branchIndexUnderLca('n0.0', '')).toBe(0);
    });
  });

  describe('enclosingContainers', () => {
    it('lists ancestors innermost-first, up to count, never past root', () => {
      expect(enclosingContainers('n0.1.2', 2)).toEqual(['n0.1', 'n0']);
      expect(enclosingContainers('n0.1.2', 1)).toEqual(['n0.1']);
      expect(enclosingContainers('n0.1.2', 0)).toEqual([]);
      expect(enclosingContainers('n0.1.2', 5)).toEqual(['n0.1', 'n0']); // stops at root
      expect(enclosingContainers('n3', 2)).toEqual([]); // top-level: nothing below root
    });
  });

  describe('branchUnderLca', () => {
    it('names the lca child the endpoint sits under', () => {
      expect(branchUnderLca('n2.1', '')).toBe('n2');
      expect(branchUnderLca('n0.3.1', 'n0')).toBe('n0.3');
      expect(branchUnderLca('n0.3', 'n0')).toBe('n0.3'); // direct child is its own branch
    });

    it('returns "" for the lca itself (a port on the lca has no branch)', () => {
      expect(branchUnderLca('n0', 'n0')).toBe('');
      expect(branchUnderLca('', '')).toBe('');
    });
  });

  describe('sideFromFlow', () => {
    it('takes the axis from the direction and the sign from later', () => {
      expect(sideFromFlow('TB', true)).toBe('s');
      expect(sideFromFlow('TB', false)).toBe('n');
      expect(sideFromFlow('BT', true)).toBe('n');
      expect(sideFromFlow('LR', true)).toBe('e');
      expect(sideFromFlow('LR', false)).toBe('w');
      expect(sideFromFlow('RL', true)).toBe('w');
    });
  });

  describe('laterFromGeometry', () => {
    const at = (x: number, y: number) => ({ x, y, w: 10, h: 10 });

    it('compares box centres on the flow axis', () => {
      expect(laterFromGeometry('TB', at(0, 0), at(0, 100))).toBe(true);
      expect(laterFromGeometry('TB', at(0, 100), at(0, 0))).toBe(false);
      expect(laterFromGeometry('BT', at(0, 0), at(0, 100))).toBe(false);
      expect(laterFromGeometry('LR', at(0, 0), at(100, 0))).toBe(true);
      expect(laterFromGeometry('RL', at(0, 0), at(100, 0))).toBe(false);
    });

    it('ignores the cross axis', () => {
      expect(laterFromGeometry('TB', at(500, 0), at(0, 100))).toBe(true);
    });

    it('gives up when the branches sit level, so declaration order stands', () => {
      expect(laterFromGeometry('TB', at(0, 40), at(300, 40))).toBeUndefined();
      expect(laterFromGeometry('LR', at(40, 0), at(40.5, 300))).toBeUndefined();
    });
  });

  describe('resolveExitSide', () => {
    it('honors an explicit side literally', () => {
      expect(resolveExitSide('n', 'n0.0', 'n1.0', '', 'LR')).toBe('n');
      expect(resolveExitSide('w', 'n0.0', 'n1.0', '', 'TB')).toBe('w');
    });

    it('auto: vertical axis from a TB/BT LCA, sign from branch order', () => {
      // target branch (n1) later than source branch (n0) under a TB root -> south.
      expect(resolveExitSide('auto', 'n0.0', 'n1.0', '', 'TB')).toBe('s');
      // earlier -> north.
      expect(resolveExitSide('auto', 'n1.0', 'n0.0', '', 'TB')).toBe('n');
      // BT reverses the sign.
      expect(resolveExitSide('auto', 'n0.0', 'n1.0', '', 'BT')).toBe('n');
      expect(resolveExitSide(undefined, 'n1.0', 'n0.0', '', 'BT')).toBe('s');
    });

    it('auto: horizontal axis from an LR/RL LCA', () => {
      expect(resolveExitSide('auto', 'n0.0', 'n1.0', '', 'LR')).toBe('e');
      expect(resolveExitSide('auto', 'n1.0', 'n0.0', '', 'LR')).toBe('w');
      expect(resolveExitSide('auto', 'n0.0', 'n1.0', '', 'RL')).toBe('w');
    });

    it('auto: a supplied later overrides the declaration-order comparison', () => {
      // n1 is declared after n0, but ELK put its box first: south becomes north.
      expect(resolveExitSide('auto', 'n0.0', 'n1.0', '', 'TB', undefined, false)).toBe('n');
      expect(resolveExitSide('auto', 'n1.0', 'n0.0', '', 'TB', undefined, true)).toBe('s');
      expect(resolveExitSide('auto', 'n0.0', 'n1.0', '', 'LR', undefined, false)).toBe('w');
    });

    it('a declared port side still outranks the geometry', () => {
      expect(resolveExitSide('auto', 'n0.0', 'n1.0', '', 'TB', 'e', false)).toBe('e');
      expect(resolveExitSide('n', 'n0.0', 'n1.0', '', 'TB', undefined, true)).toBe('n');
    });
  });

  describe('resolveEnterSide', () => {
    it('honors an explicit side literally', () => {
      expect(resolveEnterSide('n', 'e')).toBe('n');
      expect(resolveEnterSide('e', 'e')).toBe('e');
    });

    it('auto (and undefined) faces the source exit', () => {
      expect(resolveEnterSide('auto', 'e')).toBe('w');
      expect(resolveEnterSide(undefined, 's')).toBe('n');
      expect(resolveEnterSide('auto', 'n')).toBe('s');
    });
  });

});

describe('planRoute', () => {
  const base = {
    lca: '',
    lcaDir: 'LR' as Direction,
    lineType: '-->' as const,
    routing: undefined as RouteSpec | undefined,
    flatten: null as { container: string; blackBox: string[] } | null,
    connId: 'conn0',
  };

  it('classifies a non-crossing line as plain', () => {
    const plan = planRoute({ ...base, sourceId: 'n0', targetId: 'n1' });
    expect(plan).toEqual({ kind: 'plain', warnRoute: false });
  });

  it('flags a route on a non-crossing line', () => {
    const plan = planRoute({ ...base, sourceId: 'n0', targetId: 'n1', routing: { exit: 'e' } });
    expect(plan).toEqual({ kind: 'plain', warnRoute: true });
  });

  it('packages the caller-supplied flatten decision (container + black-box)', () => {
    const plan = planRoute({
      ...base,
      sourceId: 'n0.0',
      targetId: 'n1.0',
      flatten: { container: '', blackBox: ['n0.1'] },
    });
    expect(plan).toEqual({ kind: 'flatten', container: '', blackBox: ['n0.1'] });
  });

  it('routes a mixed crossing across black-boxes; depth:auto chains both sides', () => {
    // New model (docs/routing.md §4): a crossing line whose containers are SEPARATE
    // (black-boxes n0/n1) cannot ELK-route freely. Under an explicit `depth:auto` it
    // CHAINS — both sides port onto their direct-child-of-LCA black-box shell and ELK-join
    // at the LCA, no hand-drawn bridge. (`depth:auto` must be explicit: the default is
    // depth:0, a pure bridge. Without a `separate` set the same line would flatten and
    // route as one plain ELK edge with no ports.)
    const plan = planRoute({
      ...base,
      sourceId: 'n0.0',
      targetId: 'n1.0',
      routing: { depth: 'auto' },
      separate: new Set(['n0', 'n1']),
    });
    expect(plan.kind).toBe('manual');
    if (plan.kind !== 'manual') return;
    expect(plan.source.ports.map((p) => p.containerId)).toEqual(['n0']);
    expect(plan.target.ports.map((p) => p.containerId)).toEqual(['n1']);
    expect(plan.join.kind).toBe('elk');
  });

  it('depth:1 with both sides one level deep -> ELK join, ports both sides', () => {
    const plan = planRoute({
      ...base,
      sourceId: 'n0.0',
      targetId: 'n1.0',
      routing: { depth: 1 },
      separate: new Set(['n0', 'n1']),
    });
    expect(plan.kind).toBe('manual');
    if (plan.kind !== 'manual') return;
    // exit auto: LR, target branch n1 later than source n0 -> east; target enters west.
    expect(plan.source.ports).toEqual([{ containerId: 'n0', portId: 'conn0sw0', side: 'e' }]);
    expect(plan.target.ports).toEqual([{ containerId: 'n1', portId: 'conn0tw0', side: 'w' }]);
    expect(plan.join.kind).toBe('elk');
    if (plan.join.kind !== 'elk') return;
    expect(plan.join).toMatchObject({ from: 'conn0sw0', to: 'conn0tw0', container: '', arrow: 'none' });
    // arrow sits on the target chain's touch segment (endpoint at its start point).
    expect(plan.target.segments[0].arrow).toBe('start');
    expect(plan.source.segments[0].arrow).toBe('none');
  });

  it('depth caps at the nesting distance, and auto reaches the LCA', () => {
    // source is two levels deep (n0.1.0), target one (n1.0); all containers on the
    // path are SEPARATE black-boxes, so the line chains rather than flattening.
    const deep = { ...base, sourceId: 'n0.1.0', targetId: 'n1.0', separate: new Set(['n0', 'n0.1', 'n1']) };
    const d1 = planRoute({ ...deep, routing: { depth: 1 } });
    const auto = planRoute({ ...deep, routing: { depth: 'auto' } });
    const d5 = planRoute({ ...deep, routing: { depth: 5 } });
    if (d1.kind !== 'manual' || auto.kind !== 'manual' || d5.kind !== 'manual') throw new Error('manual');
    // depth:1 -> one source port (on the inner container), chain stops short -> bridge.
    expect(d1.source.ports.map((p) => p.containerId)).toEqual(['n0.1']);
    expect(d1.join.kind).toBe('bridge');
    // auto -> ports on both source levels, reaches root -> ELK join.
    expect(auto.source.ports.map((p) => p.containerId)).toEqual(['n0.1', 'n0']);
    expect(auto.join.kind).toBe('elk');
    // depth:5 clamps to the 2-level nesting distance (same as auto here).
    expect(d5.source.ports.map((p) => p.containerId)).toEqual(['n0.1', 'n0']);
  });

  it('a short chain still ELK-joins when the gap to the LCA is flattened', () => {
    // source two levels deep (n0.1.0), depth:1 -> its port lands on n0.1, one level
    // short of the root LCA. On its own that forces a bridge (see the case above).
    const deep = {
      ...base,
      sourceId: 'n0.1.0',
      targetId: 'n1.0',
      routing: { depth: 1 } as RouteSpec,
      separate: new Set(['n0', 'n0.1', 'n1']),
    };
    const plain = planRoute(deep);
    if (plain.kind !== 'manual') throw new Error('manual');
    expect(plain.join.kind).toBe('bridge');

    // But if the container BETWEEN n0.1 and the LCA (n0) is flattened (INCLUDE) while
    // the port's own container (n0.1) stays SEPARATE, the port on n0.1 is exposed at
    // the root, so ELK carries the join instead — no hand-drawn bridge.
    const exposed = planRoute({
      ...deep,
      include: new Set(['n0']),
      separate: new Set(['n0.1', 'n1']),
    });
    if (exposed.kind !== 'manual') throw new Error('manual');
    expect(exposed.source.ports.map((p) => p.containerId)).toEqual(['n0.1']);
    expect(exposed.join.kind).toBe('elk');
    if (exposed.join.kind !== 'elk') return;
    expect(exposed.join).toMatchObject({ from: 'conn0sw0', container: '' });

    // If the port's OWN container is itself flattened too, the whole path from the
    // source up to the LCA is INCLUDE: there is no black-box boundary to port on, so
    // the source grows no ports and ELK routes it freely from the node — still an ELK
    // join (in the new model a flattened path never falls back to a bridge).
    const dissolved = planRoute({ ...deep, include: new Set(['n0', 'n0.1']), separate: new Set(['n1']) });
    if (dissolved.kind !== 'manual') throw new Error('manual');
    expect(dissolved.source.ports).toEqual([]);
    expect(dissolved.join.kind).toBe('elk');
    if (dissolved.join.kind !== 'elk') return;
    expect(dissolved.join.from).toBe('n0.1.0');
  });

  it('a port on the LCA itself is reachable — the join ELK-routes, no bridge', () => {
    // A manual line whose target is a declared port ON the LCA `w` (owner === lca), with
    // the source on a direct child `x`. The port sits directly on the LCA boundary, so
    // the join edge lives in the LCA and attaches to its own port — always ELK-routable.
    // (Its nesting distance is -1, which reachesLca / the exposure walk mishandled.)
    const plan = planRoute({
      ...base,
      lca: 'n0',
      sourceId: 'px', sourceOwner: 'n0.0', sourceFixed: true, // port on child x
      targetId: 'pw', targetOwner: 'n0', targetFixed: true, // port ON the LCA w
      routing: { depth: 0 },
      separate: new Set(['n0.0']), // x is a black-box, so its boundary port shows through
    });
    if (plan.kind !== 'manual') throw new Error('manual');
    expect(plan.join.kind).toBe('elk');

    // Guard against over-firing: a deep source that is NOT exposed still bridges even
    // when the target is a port on the LCA (only the target side is trivially reachable).
    const deepSrc = planRoute({
      ...base,
      lca: 'n0',
      sourceId: 'n0.0.0', sourceOwner: 'n0.0.0', // two levels below the LCA
      targetId: 'pw', targetOwner: 'n0', targetFixed: true,
      routing: { depth: 0 },
      separate: new Set(['n0.0']), // black-box the source crosses; depth:0 stops it short
    });
    if (deepSrc.kind !== 'manual') throw new Error('manual');
    expect(deepSrc.join.kind).toBe('bridge');
  });

  it('a target directly in the LCA gets no chain; the join edge carries the head', () => {
    const plan = planRoute({
      ...base,
      sourceId: 'n0.1.0',
      targetId: 'n1', // direct child of the root LCA
      routing: { depth: 'auto' },
    });
    if (plan.kind !== 'manual') throw new Error('manual');
    expect(plan.target.ports).toEqual([]);
    expect(plan.target.segments).toEqual([]);
    expect(plan.join.kind).toBe('elk');
    if (plan.join.kind !== 'elk') return;
    expect(plan.join.to).toBe('n1'); // join reaches the target node itself
    expect(plan.join.arrow).toBe('end'); // --> head on the join, at the target
  });

  it('places the head on the source side for <--', () => {
    const plan = planRoute({
      ...base,
      sourceId: 'n0.0',
      targetId: 'n1.0',
      lineType: '<--',
      routing: { depth: 1 },
      separate: new Set(['n0', 'n1']),
    });
    if (plan.kind !== 'manual') throw new Error('manual');
    expect(plan.source.segments[0].arrow).toBe('start');
    expect(plan.target.segments[0].arrow).toBe('none');
    if (plan.join.kind === 'elk') expect(plan.join.arrow).toBe('none');
  });

  it('carries no head for --- lines', () => {
    const plan = planRoute({
      ...base,
      sourceId: 'n0.0',
      targetId: 'n1.0',
      lineType: '---',
      routing: { depth: 1 },
      separate: new Set(['n0', 'n1']),
    });
    if (plan.kind !== 'manual') throw new Error('manual');
    expect(plan.source.segments[0].arrow).toBe('none');
    expect(plan.target.segments[0].arrow).toBe('none');
    if (plan.join.kind === 'elk') expect(plan.join.arrow).toBe('none');
  });

  it('honors an explicit exit side (and mirrors it for the target)', () => {
    const plan = planRoute({
      ...base,
      sourceId: 'n0.0',
      targetId: 'n1.0',
      routing: { exit: 'n', depth: 1 },
      separate: new Set(['n0', 'n1']),
    });
    if (plan.kind !== 'manual') throw new Error('manual');
    expect(plan.source.ports[0].side).toBe('n');
    expect(plan.target.ports[0].side).toBe('s'); // facing = opposite
  });

  it('honors an explicit enter side, independent of exit', () => {
    const plan = planRoute({
      ...base,
      sourceId: 'n0.0',
      targetId: 'n1.0',
      routing: { exit: 'n', enter: 'n', depth: 1 },
      separate: new Set(['n0', 'n1']),
    });
    if (plan.kind !== 'manual') throw new Error('manual');
    expect(plan.source.ports[0].side).toBe('n');
    expect(plan.target.ports[0].side).toBe('n'); // explicit, not the facing 's'
  });

  it('depth:0 with a route hand-routes the whole line (empty chains, bridge)', () => {
    const plan = planRoute({
      ...base,
      sourceId: 'n0.1.0',
      targetId: 'n1.0',
      routing: { depth: 0 },
      separate: new Set(['n0', 'n0.1', 'n1']),
    });
    if (plan.kind !== 'manual') throw new Error('manual');
    expect(plan.source.ports).toEqual([]);
    expect(plan.target.ports).toEqual([]);
    expect(plan.join).toMatchObject({
      kind: 'bridge',
      from: { kind: 'box', id: 'n0.1.0' },
      to: { kind: 'box', id: 'n1.0' },
      arrow: 'end',
    });
  });

  it('threads bend onto the bridge only', () => {
    const bridged = planRoute({ ...base, sourceId: 'n0.1.0', targetId: 'n1.0', routing: { depth: 1, bend: 'n' }, separate: new Set(['n0', 'n0.1', 'n1']) });
    if (bridged.kind !== 'manual' || bridged.join.kind !== 'bridge') throw new Error('bridge');
    expect(bridged.join.bend).toBe('n');
  });

  it('defaults the bridge bend to auto when a route omits it', () => {
    const bridged = planRoute({ ...base, sourceId: 'n0.1.0', targetId: 'n1.0', routing: { depth: 1 }, separate: new Set(['n0', 'n0.1', 'n1']) });
    if (bridged.kind !== 'manual' || bridged.join.kind !== 'bridge') throw new Error('bridge');
    expect(bridged.join.bend).toBe('auto');
  });

  it('resolves an omitted bend to auto on a depth:0 bridge', () => {
    // `route depth:0` opts fully out of ports -> a hand-drawn bridge; with no explicit
    // bend it still yields a fully-resolved `auto` shape.
    const depth0 = planRoute({ ...base, sourceId: 'n0.0', targetId: 'n1.0', routing: { depth: 0 }, separate: new Set(['n0', 'n1']) });
    if (depth0.kind !== 'manual' || depth0.join.kind !== 'bridge') throw new Error('bridge');
    expect(depth0.join.bend).toBe('auto');
  });

  it('threads the resolved exit/enter sides onto the bridge (for l shaping)', () => {
    const bridged = planRoute({
      ...base,
      sourceId: 'n0.1.0',
      targetId: 'n1.0',
      routing: { depth: 1, exit: 'e', enter: 'n', bend: 'l' },
      separate: new Set(['n0', 'n0.1', 'n1']),
    });
    if (bridged.kind !== 'manual' || bridged.join.kind !== 'bridge') throw new Error('bridge');
    expect(bridged.join.bend).toBe('l');
    expect(bridged.join.exitSide).toBe('e');
    expect(bridged.join.enterSide).toBe('n');
  });
});

describe('planRoute with a declared-port endpoint', () => {
  // A declared `port` is fed in as a fixed anchor: its ELK id is the port id, its
  // OWNER is the port's container, and `*Fixed` is set. The reported bug's shape:
  // `alice` = n0.0 (a non-port, inside region n0), wired to the port `p-bob` =
  // n1.port0 hanging off region n1 (owner n1). LCA is the root, directions mixed.
  const base = {
    lca: '',
    lcaDir: 'TB' as Direction,
    lineType: '---' as const,
    routing: undefined as RouteSpec | undefined,
    flatten: null as { container: string; blackBox: string[] } | null,
    connId: 'conn0',
  };
  const aliceToPort = {
    ...base,
    sourceId: 'n0.0',
    sourceOwner: 'n0.0',
    sourceFixed: false,
    targetId: 'n1.port0',
    targetOwner: 'n1',
    targetFixed: true,
  };

  it('a non-crossing port line is plain (measured on the port\'s container, not its id)', () => {
    // The port id n1.port0 is two segments deep, but its OWNER n1 is a direct
    // child of the root — so the line does not cross a boundary.
    const plan = planRoute({
      ...base,
      sourceId: 'n0',
      sourceOwner: 'n0',
      sourceFixed: false,
      targetId: 'n1.port0',
      targetOwner: 'n1',
      targetFixed: true,
    });
    expect(plan).toEqual({ kind: 'plain', warnRoute: false });
  });

  it('default depth (no route) grows NO ports and bridges to the fixed port', () => {
    const plan = planRoute({ ...aliceToPort, separate: new Set(['n0', 'n1']) });
    if (plan.kind !== 'manual') throw new Error('manual');
    // n0/n1 are SEPARATE black-boxes, so the crossing line cannot flatten. The DEFAULT is
    // depth:0 (docs/routing.md §4), so neither side grows an auto-port: the free source
    // anchors on its own box, the fixed port stays pinned, and a hand-drawn bridge closes
    // the gap. `depth:auto` (next test) is the opt-in that chains instead.
    expect(plan.source.ports).toEqual([]);
    expect(plan.target.ports).toEqual([]);
    expect(plan.join.kind).toBe('bridge');
  });

  it('depth:auto chains only the free side and ELK-joins the fixed port', () => {
    const plan = planRoute({ ...aliceToPort, routing: { depth: 'auto' }, separate: new Set(['n0', 'n1']) });
    if (plan.kind !== 'manual') throw new Error('manual');
    // The free source climbs to a port on its container n0; the fixed port stays
    // pinned (no ports), and the two meet with an ELK edge in the LCA.
    expect(plan.source.ports).toEqual([{ containerId: 'n0', portId: 'conn0sw0', side: 's' }]);
    expect(plan.target.ports).toEqual([]);
    expect(plan.target.endpoint).toBe('n1.port0');
    expect(plan.join.kind).toBe('elk');
    if (plan.join.kind !== 'elk') return;
    expect(plan.join).toMatchObject({ from: 'conn0sw0', to: 'n1.port0', container: '' });
  });

  it('chains a fixed port nested below the LCA through its enclosing containers', () => {
    // The declared port hangs off n1.0, itself one level below the root LCA. The
    // fixed side grows no port on its own container (the declared port is already
    // there) but chains from that container's parent (n1) up to the LCA, so it
    // reaches the LCA and the two sides meet with an ELK edge — no bridge.
    const plan = planRoute({
      ...aliceToPort,
      targetId: 'n1.0.port0',
      targetOwner: 'n1.0',
      routing: { depth: 'auto' },
      separate: new Set(['n0', 'n1', 'n1.0']),
    });
    if (plan.kind !== 'manual') throw new Error('manual');
    expect(plan.target.ports).toEqual([{ containerId: 'n1', portId: 'conn0tw0', side: 'n' }]);
    // the chain's first hop starts from the declared port, not a new port on n1.0.
    expect(plan.target.segments[0]).toMatchObject({ from: 'n1.0.port0', to: 'conn0tw0', container: 'n1' });
    expect(plan.join.kind).toBe('elk');
    if (plan.join.kind !== 'elk') return;
    expect(plan.join).toMatchObject({ from: 'conn0sw0', to: 'conn0tw0', container: '' });
  });

  it('a nested fixed port still bridges when depth stops the chain short of the LCA', () => {
    // depth:0 → the fixed port grows no chain and stays pinned at its point; the
    // free side bridges to it (the default when no depth is requested).
    const plan = planRoute({
      ...aliceToPort,
      targetId: 'n1.0.port0',
      targetOwner: 'n1.0',
      routing: { depth: 0 },
      separate: new Set(['n0', 'n1', 'n1.0']),
    });
    if (plan.kind !== 'manual') throw new Error('manual');
    expect(plan.target.ports).toEqual([]);
    expect(plan.join.kind).toBe('bridge');
    if (plan.join.kind !== 'bridge') return;
    expect(plan.join.to).toEqual({ kind: 'port', portId: 'n1.0.port0' });
  });

  it('places the --> head on the join when it lands on the fixed port', () => {
    const plan = planRoute({ ...aliceToPort, lineType: '-->', routing: { depth: 'auto' }, separate: new Set(['n0', 'n1']) });
    if (plan.kind !== 'manual' || plan.join.kind !== 'elk') throw new Error('elk join');
    // The port side has no chain, so the head rides the join edge at its target.
    expect(plan.join.arrow).toBe('end');
    expect(plan.source.segments[0].arrow).toBe('none');
  });

  it('places the <-- head on the free side\'s touch segment', () => {
    const plan = planRoute({ ...aliceToPort, lineType: '<--', routing: { depth: 'auto' }, separate: new Set(['n0', 'n1']) });
    if (plan.kind !== 'manual') throw new Error('manual');
    expect(plan.source.segments[0].arrow).toBe('start');
    if (plan.join.kind === 'elk') expect(plan.join.arrow).toBe('none');
  });

  it('handles the port on the source side symmetrically', () => {
    const plan = planRoute({
      ...base,
      sourceId: 'n0.port0',
      sourceOwner: 'n0',
      sourceFixed: true,
      targetId: 'n1.0',
      targetOwner: 'n1.0',
      targetFixed: false,
      routing: { depth: 'auto' },
      separate: new Set(['n0', 'n1', 'n1.0']),
    });
    if (plan.kind !== 'manual') throw new Error('manual');
    expect(plan.source.ports).toEqual([]); // fixed port grows nothing
    expect(plan.target.ports.map((p) => p.containerId)).toEqual(['n1']); // the node climbs
    if (plan.join.kind !== 'elk') throw new Error('elk join');
    expect(plan.join).toMatchObject({ from: 'n0.port0', to: 'conn0tw0' });
  });

  it('a port-to-port line whose containers are both direct LCA children is plain', () => {
    // Both ports' OWNERS (n0, n1) are direct children of the root, so no boundary
    // is crossed — ELK routes port→port directly. (The port ids being two levels
    // deep must not fool the crossing test; it is measured on the owner.)
    const plan = planRoute({
      ...base,
      sourceId: 'n0.port0',
      sourceOwner: 'n0',
      sourceFixed: true,
      targetId: 'n1.port0',
      targetOwner: 'n1',
      targetFixed: true,
    });
    expect(plan).toEqual({ kind: 'plain', warnRoute: false });
  });

  it('a port-to-port line with one side nested chains that side and ELK-joins under depth:auto', () => {
    // The source port sits on n0 (direct LCA child, so it needs no chain); the target
    // port is on n1.0, one level below the LCA. Under an explicit `depth:auto` the target
    // chains a port up onto n1 and the two meet by an ELK edge. (The default, depth:0,
    // bridges the two port points directly instead.)
    const plan = planRoute({
      ...base,
      sourceId: 'n0.port0',
      sourceOwner: 'n0',
      sourceFixed: true,
      targetId: 'n1.0.port0',
      targetOwner: 'n1.0',
      targetFixed: true,
      routing: { depth: 'auto' },
      separate: new Set(['n0', 'n1', 'n1.0']),
    });
    if (plan.kind !== 'manual') throw new Error('manual');
    expect(plan.source.ports).toEqual([]);
    expect(plan.target.ports.map((p) => p.containerId)).toEqual(['n1']);
    expect(plan.join.kind).toBe('elk');
  });
});

// A compact DirNode tree for analyzeFlatten, plus the SEPARATE (black-box) set the
// direction-normalization pre-pass derives from the declared `dir`s. `dir` is the
// AUTHOR-declared direction; normalizeDirections collapses single-child-chain shells
// and decides which branching containers are boundaries. `rootDir` is the diagram flow.
function tree(
  root: { id: string; dir?: Direction; children?: unknown[] },
  rootDir: Direction = 'LR' as Direction,
): {
  nodeOf: (id: string) => DirNode | undefined;
  separate: Set<string>;
} {
  const byId = new Map<string, DirNode>();
  const explicitDir = new Map<string, Direction>();
  const walk = (s: { id: string; dir?: Direction; children?: unknown[] }): DirNode => {
    const node: DirNode = {
      id: s.id,
      children: (s.children ?? []).map((c) => walk(c as { id: string; dir?: Direction; children?: unknown[] })),
    };
    byId.set(s.id, node);
    if (s.dir) explicitDir.set(s.id, s.dir);
    return node;
  };
  const rootNode = walk(root);
  byId.set('', rootNode);
  const { separate } = normalizeDirections(rootNode, explicitDir, rootDir);
  return { nodeOf: (id) => byId.get(id), separate };
}

describe('analyzeFlatten', () => {
  const LR = 'LR' as Direction;
  const TB = 'TB' as Direction;

  it('returns null for a non-crossing line', () => {
    const { nodeOf, separate } = tree({ id: 'root', children: [{ id: 'n0' }, { id: 'n1' }] });
    expect(
      analyzeFlatten(
        { sourceOwner: 'n0', targetOwner: 'n1', sourceFixed: false, targetFixed: false, lca: '' },
        nodeOf,
        separate,
      ),
    ).toBeNull();
  });

  it('flattens the LCA (no raise) for a port on a DESCENDANT of it', () => {
    // alice n0.0 --- port whose owner n1 is a direct child of the root LCA.
    const { nodeOf, separate } = tree({
      id: 'root',
      children: [
        { id: 'n0', children: [{ id: 'n0.0' }] },
        { id: 'n1', children: [{ id: 'n1.0' }] },
      ],
    });
    const plan = analyzeFlatten(
      { sourceOwner: 'n0.0', targetOwner: 'n1', sourceFixed: false, targetFixed: true, lca: '' },
      nodeOf,
      separate,
    );
    expect(plan?.container).toBe('');
    expect(plan?.blackBox).toEqual([]);
    // The corridor holds the node side (n0.0 -> n0) but NOT the port's own container
    // n1 — the line meets the port on n1's boundary, so it never enters n1's interior.
    expect([...(plan?.spine ?? [])].sort()).toEqual(['n0', 'n0.0']);
  });

  it('raises the flatten to the LCA parent for a deep line to a port ON the LCA', () => {
    // root > x(n0) > a(n0.0) > b(n0.0.0) > c(n0.0.0.0); port on a. All LR.
    const { nodeOf, separate } = tree({
      id: 'root',
      dir: LR,
      children: [
        {
          id: 'n0',
          dir: LR,
          children: [{ id: 'n0.0', dir: LR, children: [{ id: 'n0.0.0', dir: LR, children: [{ id: 'n0.0.0.0' }] }] }],
        },
      ],
    });
    const plan = analyzeFlatten(
      { sourceOwner: 'n0.0.0.0', targetOwner: 'n0.0', sourceFixed: false, targetFixed: true, lca: 'n0.0' },
      nodeOf,
      separate,
    );
    expect(plan?.container).toBe('n0');
    expect(plan?.blackBox).toEqual([]);
  });

  it('black-boxes an off-spine differing sibling instead of bailing', () => {
    // x(n0) also holds d(n0.1, TB, 2 children) off the spine. Flattening x would
    // rotate d, so d is black-boxed (SEPARATE) and the flatten still happens.
    const { nodeOf, separate } = tree({
      id: 'root',
      dir: LR,
      children: [
        {
          id: 'n0',
          dir: LR,
          children: [
            { id: 'n0.0', dir: LR, children: [{ id: 'n0.0.0', dir: LR, children: [{ id: 'n0.0.0.0' }] }] },
            { id: 'n0.1', dir: TB, children: [{ id: 'n0.1.0' }, { id: 'n0.1.1' }] },
          ],
        },
      ],
    });
    const plan = analyzeFlatten(
      { sourceOwner: 'n0.0.0.0', targetOwner: 'n0.0', sourceFixed: false, targetFixed: true, lca: 'n0.0' },
      nodeOf,
      separate,
    );
    expect(plan?.container).toBe('n0');
    expect(plan?.blackBox).toEqual(['n0.1']);
  });

  it('returns null when a differing container sits ON the spine', () => {
    // a(n0.0) is TB with 2 children and hosts the target port — it is on the spine
    // after the raise to x, so flattening x would rotate it. Not flattenable.
    const { nodeOf, separate } = tree({
      id: 'root',
      dir: LR,
      children: [
        {
          id: 'n0',
          dir: LR,
          children: [
            {
              id: 'n0.0',
              dir: TB,
              children: [{ id: 'n0.0.0', dir: LR, children: [{ id: 'n0.0.0.0' }] }, { id: 'n0.0.1' }],
            },
          ],
        },
      ],
    });
    expect(
      analyzeFlatten(
        { sourceOwner: 'n0.0.0.0', targetOwner: 'n0.0', sourceFixed: false, targetFixed: true, lca: 'n0.0' },
        nodeOf,
        separate,
      ),
    ).toBeNull();
  });

  it('does not raise when the port-on-LCA counterpart is a direct child', () => {
    // b(n0.0.0) is a direct child of a(n0.0); node -> port-on-parent needs no raise.
    const { nodeOf, separate } = tree({
      id: 'root',
      dir: LR,
      children: [{ id: 'n0', dir: LR, children: [{ id: 'n0.0', dir: LR, children: [{ id: 'n0.0.0' }, { id: 'n0.0.1' }] }] }],
    });
    const plan = analyzeFlatten(
      { sourceOwner: 'n0.0.0', targetOwner: 'n0.0', sourceFixed: false, targetFixed: true, lca: 'n0.0' },
      nodeOf,
      separate,
    );
    expect(plan?.container).toBe('n0.0');
    expect(plan?.blackBox).toEqual([]);
  });

  it('black-boxes the HIGHEST differing container, not its 2+-children descendant', () => {
    // n0.1 = w (TB, ONE child) wraps n0.1.0 = x (TB, two children). Flattening the
    // root (LR) black-boxes the highest differing node — w — rather than descending
    // past it to x. Keeping the whole tb chain as one opaque box is what lets a
    // nested line flatten-root under it (the wrapper case).
    const { nodeOf, separate } = tree({
      id: 'root',
      dir: LR,
      children: [
        {
          id: 'n0',
          dir: LR,
          children: [
            { id: 'n0.0' },
            { id: 'n0.1', dir: TB, children: [{ id: 'n0.1.0', dir: TB, children: [{ id: 'n0.1.0.0' }, { id: 'n0.1.0.1' }] }] },
          ],
        },
        { id: 'n1', dir: LR, children: [{ id: 'n1.0' }] },
      ],
    });
    const plan = analyzeFlatten(
      { sourceOwner: 'n0.0', targetOwner: 'n1.0', sourceFixed: false, targetFixed: false, lca: '' },
      nodeOf,
      separate,
    );
    expect(plan?.container).toBe('');
    expect(plan?.blackBox).toEqual(['n0.1']); // w, not x (n0.1.0)
  });

  it('does NOT black-box a differing container with no visible foreign content', () => {
    // n0.1 is a tb single-child chain down to a leaf — nothing 2+-child differs, so
    // flattening it into lr is invisible. It is transparent, not a boundary: no
    // black-box. (Contrast the previous test, where the chain bottomed out in a grid.)
    const { nodeOf, separate } = tree({
      id: 'root',
      dir: LR,
      children: [
        {
          id: 'n0',
          dir: LR,
          children: [
            { id: 'n0.0' },
            { id: 'n0.1', dir: TB, children: [{ id: 'n0.1.0', dir: TB, children: [{ id: 'n0.1.0.0' }] }] },
          ],
        },
        { id: 'n1', dir: LR, children: [{ id: 'n1.0' }] },
      ],
    });
    const plan = analyzeFlatten(
      { sourceOwner: 'n0.0', targetOwner: 'n1.0', sourceFixed: false, targetFixed: false, lca: '' },
      nodeOf,
      separate,
    );
    expect(plan?.container).toBe('');
    expect(plan?.blackBox).toEqual([]); // n0.1 is transparent (no 2+-child foreign)
  });
});
