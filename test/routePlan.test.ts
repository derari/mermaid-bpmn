import { describe, expect, it } from 'vitest';
import type { Direction, RouteSpec } from '../src/db.js';
import {
  type DirNode,
  branchIndexUnderLca,
  enclosingContainers,
  parentId,
  planRoute,
  resolveEnterSide,
  resolveExitSide,
  segCount,
  subtreeDirectionsUniform,
} from '../src/routePlan.js';

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

  describe('subtreeDirectionsUniform', () => {
    const tree: DirNode = {
      id: 'n0',
      children: [
        { id: 'n0.0', children: [{ id: 'n0.0.0' }, { id: 'n0.0.1' }] },
        { id: 'n0.1', children: [{ id: 'n0.1.0' }, { id: 'n0.1.1' }] },
      ],
    };
    it('is true when every 2+-child container flows the given direction', () => {
      const dirs = new Map<string, Direction>([
        ['n0', 'TB'],
        ['n0.0', 'TB'],
        ['n0.1', 'TB'],
      ]);
      expect(subtreeDirectionsUniform(tree, 'TB', dirs)).toBe(true);
    });
    it('is false when a 2+-child container flows differently', () => {
      const dirs = new Map<string, Direction>([
        ['n0', 'TB'],
        ['n0.0', 'LR'], // differs, and has 2 children -> breaks uniformity
        ['n0.1', 'TB'],
      ]);
      expect(subtreeDirectionsUniform(tree, 'TB', dirs)).toBe(false);
    });
    it('ignores a differing container that has fewer than 2 children', () => {
      const single: DirNode = { id: 'n0', children: [{ id: 'n0.0', children: [{ id: 'n0.0.0' }] }] };
      const dirs = new Map<string, Direction>([['n0.0', 'LR']]);
      expect(subtreeDirectionsUniform(single, 'TB', dirs)).toBe(true);
    });
  });
});

describe('planRoute', () => {
  const base = {
    lca: '',
    lcaDir: 'LR' as Direction,
    lineType: '-->' as const,
    routing: undefined as RouteSpec | undefined,
    uniform: false,
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

  it('classifies a uniform boundary-crossing line as flatten', () => {
    const plan = planRoute({ ...base, sourceId: 'n0.0', targetId: 'n1.0', uniform: true });
    expect(plan).toEqual({ kind: 'flatten' });
  });

  it('routes a mixed crossing manually; default (no route) is depth 0 -> bridge box↔box', () => {
    const plan = planRoute({ ...base, sourceId: 'n0.0', targetId: 'n1.0' });
    expect(plan.kind).toBe('manual');
    if (plan.kind !== 'manual') return;
    expect(plan.source.ports).toEqual([]);
    expect(plan.target.ports).toEqual([]);
    expect(plan.join).toMatchObject({
      kind: 'bridge',
      from: { kind: 'box', id: 'n0.0' },
      to: { kind: 'box', id: 'n1.0' },
      arrow: 'end', // --> touches the target box directly (no target chain)
    });
  });

  it('depth:1 with both sides one level deep -> ELK join, ports both sides', () => {
    const plan = planRoute({
      ...base,
      sourceId: 'n0.0',
      targetId: 'n1.0',
      routing: { depth: 1 },
    });
    expect(plan.kind).toBe('manual');
    if (plan.kind !== 'manual') return;
    // exit auto: LR, target branch n1 later than source n0 -> east; target enters west.
    expect(plan.source.ports).toEqual([{ containerId: 'n0', portId: 'conn0sp0', side: 'e' }]);
    expect(plan.target.ports).toEqual([{ containerId: 'n1', portId: 'conn0tp0', side: 'w' }]);
    expect(plan.join.kind).toBe('elk');
    if (plan.join.kind !== 'elk') return;
    expect(plan.join).toMatchObject({ from: 'conn0sp0', to: 'conn0tp0', container: '', arrow: 'none' });
    // arrow sits on the target chain's touch segment (endpoint at its start point).
    expect(plan.target.segments[0].arrow).toBe('start');
    expect(plan.source.segments[0].arrow).toBe('none');
  });

  it('depth caps at the nesting distance, and auto reaches the LCA', () => {
    // source is two levels deep (n0.1.0), target one (n1.0).
    const deep = { ...base, sourceId: 'n0.1.0', targetId: 'n1.0' };
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
    const bridged = planRoute({ ...base, sourceId: 'n0.1.0', targetId: 'n1.0', routing: { depth: 1, bend: 'n' } });
    if (bridged.kind !== 'manual' || bridged.join.kind !== 'bridge') throw new Error('bridge');
    expect(bridged.join.bend).toBe('n');
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
    uniform: false,
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

  it('a uniform crossing to a port flattens (same rule as node lines)', () => {
    const plan = planRoute({ ...aliceToPort, uniform: true });
    expect(plan).toEqual({ kind: 'flatten' });
  });

  it('default depth bridges the free box to the fixed port point', () => {
    const plan = planRoute(aliceToPort);
    if (plan.kind !== 'manual') throw new Error('manual');
    // The fixed port grows no ports of its own; the free side is depth 0 too by
    // default, so both sides are chainless and meet by a hand-drawn bridge.
    expect(plan.source.ports).toEqual([]);
    expect(plan.target.ports).toEqual([]);
    expect(plan.join).toMatchObject({
      kind: 'bridge',
      from: { kind: 'box', id: 'n0.0' }, // the free node's box
      to: { kind: 'port', portId: 'n1.port0' }, // the declared port's point
      arrow: 'none', // --- carries no head
    });
  });

  it('depth:auto chains only the free side and ELK-joins the fixed port', () => {
    const plan = planRoute({ ...aliceToPort, routing: { depth: 'auto' } });
    if (plan.kind !== 'manual') throw new Error('manual');
    // The free source climbs to a port on its container n0; the fixed port stays
    // pinned (no ports), and the two meet with an ELK edge in the LCA.
    expect(plan.source.ports).toEqual([{ containerId: 'n0', portId: 'conn0sp0', side: 's' }]);
    expect(plan.target.ports).toEqual([]);
    expect(plan.target.endpoint).toBe('n1.port0');
    expect(plan.join.kind).toBe('elk');
    if (plan.join.kind !== 'elk') return;
    expect(plan.join).toMatchObject({ from: 'conn0sp0', to: 'n1.port0', container: '' });
  });

  it('never grows routing ports on the fixed side, even at depth:auto with a nested port', () => {
    // The declared port hangs off n1.0 (itself nested below the root LCA). The
    // fixed side is still pinned at depth 0 — it does not reach the LCA — so the
    // join is a bridge from the free chain to the port point.
    const plan = planRoute({
      ...aliceToPort,
      targetId: 'n1.0.port0',
      targetOwner: 'n1.0',
      routing: { depth: 'auto' },
    });
    if (plan.kind !== 'manual') throw new Error('manual');
    expect(plan.target.ports).toEqual([]);
    expect(plan.join.kind).toBe('bridge');
    if (plan.join.kind !== 'bridge') return;
    expect(plan.join.to).toEqual({ kind: 'port', portId: 'n1.0.port0' });
  });

  it('places the --> head on the join when it lands on the fixed port', () => {
    const plan = planRoute({ ...aliceToPort, lineType: '-->', routing: { depth: 'auto' } });
    if (plan.kind !== 'manual' || plan.join.kind !== 'elk') throw new Error('elk join');
    // The port side has no chain, so the head rides the join edge at its target.
    expect(plan.join.arrow).toBe('end');
    expect(plan.source.segments[0].arrow).toBe('none');
  });

  it('places the <-- head on the free side\'s touch segment', () => {
    const plan = planRoute({ ...aliceToPort, lineType: '<--', routing: { depth: 'auto' } });
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
    });
    if (plan.kind !== 'manual') throw new Error('manual');
    expect(plan.source.ports).toEqual([]); // fixed port grows nothing
    expect(plan.target.ports.map((p) => p.containerId)).toEqual(['n1']); // the node climbs
    if (plan.join.kind !== 'elk') throw new Error('elk join');
    expect(plan.join).toMatchObject({ from: 'n0.port0', to: 'conn0tp0' });
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

  it('a port-to-port line with one container nested chains neither side (both fixed) → bridge', () => {
    // The source port sits on n0 (direct LCA child); the target port on n1.0
    // (nested). Crossing + mixed → manual, but neither fixed side grows ports, so
    // the two port points meet by a hand-drawn bridge.
    const plan = planRoute({
      ...base,
      sourceId: 'n0.port0',
      sourceOwner: 'n0',
      sourceFixed: true,
      targetId: 'n1.0.port0',
      targetOwner: 'n1.0',
      targetFixed: true,
    });
    if (plan.kind !== 'manual') throw new Error('manual');
    expect(plan.source.ports).toEqual([]);
    expect(plan.target.ports).toEqual([]);
    expect(plan.join).toMatchObject({
      kind: 'bridge',
      from: { kind: 'port', portId: 'n0.port0' },
      to: { kind: 'port', portId: 'n1.0.port0' },
    });
  });
});
