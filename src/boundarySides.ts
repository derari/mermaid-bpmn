import { BOUNDARY_OPERATIONS, type Direction, type Entity, type Line, type Side } from './db.js';

// Picks the border side for a boundary event whose side was left to `auto` (or
// omitted). Kept pure (no ELK, no DOM) so it can be unit-tested directly like
// portTypes.ts / routePlan.ts. The renderer calls it once up front, then consults
// the result when building each activity's border ports; anything not in the map
// falls back to the plain 90°-clockwise-of-flow default (see ROTATE_CW_90).
//
// The heuristic: a boundary event's exception flow should leave toward its target.
// Port sides are fixed BEFORE layout, so we cannot use positions — but the entity
// tree already says which lane/branch the target sits in. When the target lives in
// a sibling branch that stacks PERPENDICULAR to the host's flow (the classic case:
// a handler in an adjacent lane), we pin the event to the cross side facing that
// branch. When the target is along the flow axis instead (same lane, up/downstream)
// there is no cross signal — the event would collide with the host's own sequence
// flow — so we return nothing and let the caller use the 90°-cw default.

// Toggles a direction to its perpendicular axis, sign preserved: TB↔LR, BT↔RL.
// A pool — and the diagram root when it holds pools — stacks its children ACROSS
// the flow (this toggled axis); every other container stacks along the flow.
// Mirrors the renderer's elkDir choice (see TOGGLE_AXIS there).
const TOGGLE_AXIS: Record<Direction, Direction> = { TB: 'LR', LR: 'TB', BT: 'RL', RL: 'BT' };
const AXIS: Record<Direction, 'H' | 'V'> = { LR: 'H', RL: 'H', TB: 'V', BT: 'V' };
// The side later-declared children sit toward, per stacking direction: a DOWN (TB)
// stack grows south, an UP (BT) stack north, and so on.
const LATER_SIDE: Record<Direction, Side> = { TB: 's', BT: 'n', LR: 'e', RL: 'w' };
const OPPOSITE: Record<Side, Side> = { n: 's', s: 'n', e: 'w', w: 'e' };

function isBoundaryEvent(e: Entity): boolean {
  return e.type === 'event' && e.eventOperation !== undefined && BOUNDARY_OPERATIONS.has(e.eventOperation);
}

// The direction a container stacks its children along — the toggled axis for a
// pool (and for a root holding pools, via `togglesLikePool`), along the flow
// otherwise.
function childStackDir(container: Entity, flow: Direction, togglesLikePool: boolean): Direction {
  return container.type === 'pool' || togglesLikePool ? TOGGLE_AXIS[flow] : flow;
}

export function resolveBoundaryAutoSides(
  root: Entity,
  diagramDirection: Direction,
  lines: Line[],
): Map<Entity, Side> {
  const result = new Map<Entity, Side>();
  // The root stacks its children across the flow (like a pool) when it holds pools.
  const rootHasPools = root.children.some((c) => c.type === 'pool');

  // One walk records: each entity's parent, its index within that parent, its
  // effective flow (own direction, else inherited), a first-wins name index, and
  // the full entity list. The root's flow is the diagram direction.
  const parent = new Map<Entity, Entity | null>();
  const childIndex = new Map<Entity, number>();
  const flow = new Map<Entity, Direction>();
  const byName = new Map<string, Entity>();
  const all: Entity[] = [];
  const walk = (e: Entity, p: Entity | null, inherited: Direction): void => {
    parent.set(e, p);
    all.push(e);
    if (e.name && !byName.has(e.name)) byName.set(e.name, e);
    const ef = e.direction ?? inherited;
    flow.set(e, ef);
    e.children.forEach((c, i) => {
      childIndex.set(c, i);
      walk(c, e, ef);
    });
  };
  walk(root, null, diagramDirection);

  const resolve = (ep: Entity | string): Entity | undefined =>
    typeof ep === 'string' ? byName.get(ep) : ep;

  // The ancestor chain of an entity, from itself up to the root (inclusive).
  const chain = (e: Entity): Entity[] => {
    const out: Entity[] = [];
    let cur: Entity | null | undefined = e;
    while (cur) {
      out.push(cur);
      cur = parent.get(cur) ?? null;
    }
    return out;
  };

  for (const host of all) {
    if (host.type !== 'activity') continue;
    const hostFlow = flow.get(host) as Direction;
    for (const child of host.children) {
      if (!isBoundaryEvent(child)) continue;
      // Explicit sides are honoured verbatim by the caller — only auto/omitted
      // events get a smart pick.
      if (child.boundarySide && child.boundarySide !== 'auto') continue;

      // The distinct entities this event's flow connects to (either arrow
      // direction). Exactly one clear partner is needed to face a side; the host
      // itself and unresolved names are ignored.
      const partners = new Set<Entity>();
      for (const line of lines) {
        const s = resolve(line.source);
        const t = resolve(line.target);
        if (s === child && t && t !== host) partners.add(t);
        else if (t === child && s && s !== host) partners.add(s);
      }
      if (partners.size !== 1) continue;
      const target = [...partners][0];

      // The lowest common container of host and target, and the branch of it that
      // each sits in (the direct child of the container on either side).
      const hostChain = chain(host);
      const targetChain = chain(target);
      const targetSet = new Set(targetChain);
      const lca = hostChain.find((e) => targetSet.has(e));
      if (!lca) continue;
      const hi = hostChain.indexOf(lca);
      const ti = targetChain.indexOf(lca);
      if (hi <= 0 || ti <= 0) continue; // one is an ancestor of the other — no signal
      const hostBranch = hostChain[hi - 1];
      const targetBranch = targetChain[ti - 1];

      const stackDir = childStackDir(lca, flow.get(lca) as Direction, lca === root && rootHasPools);
      // Only a stack PERPENDICULAR to the host's flow yields a usable cross side;
      // an along-flow stack (same lane, up/downstream) collides with the host's own
      // sequence flow, so leave it to the 90°-cw default.
      if (AXIS[stackDir] === AXIS[hostFlow]) continue;

      const later = LATER_SIDE[stackDir];
      const hostIdx = childIndex.get(hostBranch) ?? 0;
      const targetIdx = childIndex.get(targetBranch) ?? 0;
      result.set(child, targetIdx > hostIdx ? later : OPPOSITE[later]);
    }
  }

  return result;
}
