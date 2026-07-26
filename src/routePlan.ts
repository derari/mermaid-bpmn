import type { Direction, LineType, RouteSpec, Side } from './db.js';

// Pure routing decisions, kept free of ELK and the DOM so they can be unit-tested
// directly (like geometry.ts / styleModel.ts). The renderer computes the graph
// facts these need (node ids, per-container direction, subtree uniformity) and
// then *applies* the returned plan; nothing here mutates a graph or draws.

// Which end of a drawn segment carries an arrowhead: at its start point, its end
// point, or neither. A polyline is drawn source-point-first, so `start` marks the
// source-ward end.
export type ArrowEnd = 'none' | 'start' | 'end';

// One end of a hand-drawn bridge: a node's box, or a laid-out port point.
export type Anchor = { kind: 'box'; id: string } | { kind: 'port'; portId: string };

// The facing side, used to derive the target's entry from the source's exit.
export const OPPOSITE: Record<Side, Side> = { n: 's', s: 'n', e: 'w', w: 'e' };

// ---- dot-path id helpers -------------------------------------------------

// The id of a node's parent container: its dot-path with the last segment
// dropped ('' for a top-level node, i.e. a direct child of the root graph).
export function parentId(id: string): string {
  const i = id.lastIndexOf('.');
  return i < 0 ? '' : id.slice(0, i);
}

// How many container levels a dot-path id carries. The root graph is '' (0);
// a top-level node `n3` is 1; a nested `n3.1` is 2.
export function segCount(id: string): number {
  return id === '' ? 0 : id.split('.').length;
}

// The numeric index of the branch — the child of `lca` — on the dot-path to `id`.
// Top-level ids are `n0`, `n1`, …; nested segments are plain integers, so both
// parse after stripping a leading `n`. Used by `auto` exit to compare where the
// source and target branches sit under their common ancestor.
export function branchIndexUnderLca(id: string, lca: string): number {
  const segs = id.split('.');
  const seg = segs[segCount(lca)] ?? segs[segs.length - 1];
  const n = Number.parseInt(seg.replace(/^n/, ''), 10);
  return Number.isNaN(n) ? 0 : n;
}

// The container ids a port chain runs through for an endpoint, innermost first:
// the endpoint's direct container, then its parent, and so on for `count` levels.
// `count` is expected pre-clamped to the nesting distance, so none is the LCA.
export function enclosingContainers(endpointId: string, count: number): string[] {
  const out: string[] = [];
  let id = parentId(endpointId);
  for (let i = 0; i < count && id !== ''; i++) {
    out.push(id);
    id = parentId(id);
  }
  return out;
}

// ---- direction uniformity ------------------------------------------------

// The minimal tree shape subtreeDirectionsUniform needs (an ElkNode satisfies it).
export interface DirNode {
  id: string;
  children?: DirNode[];
}

// Whether every container inside `node`'s subtree lays its children out along
// `dir` — the direction INCLUDE_CHILDREN would impose on the whole subtree. Only
// containers with 2+ children matter (a single child looks the same either way).
// When true, flattening the subtree changes nothing visible.
export function subtreeDirectionsUniform(
  node: DirNode,
  dir: Direction,
  dirById: Map<string, Direction>,
): boolean {
  for (const child of node.children ?? []) {
    if ((child.children?.length ?? 0) >= 2 && (dirById.get(child.id) ?? dir) !== dir) {
      return false;
    }
    if (!subtreeDirectionsUniform(child, dir, dirById)) return false;
  }
  return true;
}

// ---- exit side -----------------------------------------------------------

// The side of the source's container the line should leave from. An explicit
// side wins literally (even against the geometry — the line then loops around).
// `auto` takes its AXIS from the LCA's flow direction — a vertically-flowing LCA
// stacks its children top to bottom, so a line to another branch leaves
// north/south — and its SIGN from whether the target's branch sits later than the
// source's in that flow.
export function resolveExitSide(
  exit: RouteSpec['exit'],
  sourceId: string,
  targetId: string,
  lca: string,
  lcaDir: Direction,
): Side {
  if (exit && exit !== 'auto') return exit;
  const later = branchIndexUnderLca(targetId, lca) > branchIndexUnderLca(sourceId, lca);
  if (lcaDir === 'TB' || lcaDir === 'BT') {
    return (lcaDir === 'TB' ? later : !later) ? 's' : 'n';
  }
  return (lcaDir === 'LR' ? later : !later) ? 'e' : 'w';
}

// The side of the target's container the line enters on. An explicit side wins
// literally; `auto` (the default) faces the source's exit, i.e. the opposite of
// the resolved exit side — the original behaviour before `enter` existed.
export function resolveEnterSide(enter: RouteSpec['enter'], exitSide: Side): Side {
  if (enter && enter !== 'auto') return enter;
  return OPPOSITE[exitSide];
}

// ---- the plan ------------------------------------------------------------

// A port to create on a container, plus the ELK edge routing to it.
export interface PortSpec {
  containerId: string;
  portId: string;
  side: Side;
}
export interface Segment {
  id: string;
  from: string;
  to: string;
  container: string; // the container this ELK edge lives in
  arrow: ArrowEnd;
}
// One side of a manual route: the port chain climbing out of an endpoint.
export interface ChainPlan {
  ports: PortSpec[]; // innermost first
  segments: Segment[]; // endpoint -> port -> port …, one per port
  endpoint: string; // outer ELK endpoint: the outer port id, or the node id when empty
  anchor: Anchor; // bridge anchor for this side
  reachesLca: boolean; // outer anchor is a direct child of the LCA
}
// How the two chains meet: an ELK edge in the LCA (both reached it), or a bridge.
export type JoinPlan =
  | { kind: 'elk'; id: string; from: string; to: string; container: string; arrow: ArrowEnd }
  | {
      kind: 'bridge';
      from: Anchor;
      to: Anchor;
      arrow: ArrowEnd;
      bend?: 'z' | 'n' | 'l' | 'auto';
      // The resolved exit/enter edges, so the renderer can shape an `l` bend (and
      // auto-detect a 90° `l`) off the sides the ports were placed on.
      exitSide: Side;
      enterSide: Side;
    };

// The full verdict for one line.
//  - `plain`   both endpoints are direct children of the LCA → a normal ELK edge.
//              `warnRoute` flags a `route` that has nothing to tune here.
//  - `flatten` a boundary-crossing line whose LCA subtree is uniform → ELK routes
//              it once the LCA flattens (INCLUDE_CHILDREN).
//  - `manual`  a boundary-crossing line whose LCA mixes directions → port chains
//              joined at the LCA (ELK) or by a hand-drawn bridge.
export type RoutePlan =
  | { kind: 'plain'; warnRoute: boolean }
  | { kind: 'flatten' }
  | { kind: 'manual'; source: ChainPlan; target: ChainPlan; join: JoinPlan };

export interface RouteInput {
  // The ELK anchor an edge attaches to: a node id, or — for a declared `port`
  // endpoint — the port id. Nesting/LCA math uses `*Owner` instead (below).
  sourceId: string;
  targetId: string;
  // The id that governs an endpoint's nesting: its node id, or a declared port's
  // CONTAINER id. Defaults to the anchor id, so a plain node needs neither field.
  sourceOwner?: string;
  targetOwner?: string;
  // Whether the endpoint is a declared `port` — a fixed anchor already pinned on
  // its container's boundary. Such a side grows no routing ports of its own (it is
  // pinned at depth 0) and anchors on the port point; the OTHER side chains to it.
  sourceFixed?: boolean;
  targetFixed?: boolean;
  // The border side a fixed endpoint's port sits on. A fixed port is physically
  // pinned to this edge, so a hand-drawn bridge must attach along its axis — it
  // overrides the auto/geometry exit (source) or enter (target) side, which was
  // derived from the LCA's flow and is unrelated to where the port actually sits.
  sourcePortSide?: Side;
  targetPortSide?: Side;
  lca: string;
  lcaDir: Direction;
  lineType: LineType;
  routing: RouteSpec | undefined;
  uniform: boolean; // is the LCA subtree direction-uniform (caller computes it)
  connId: string; // id prefix for generated ports/segments
}

// Plans one side's port chain: a port on each enclosing container up to `depth`,
// with an ELK edge climbing endpoint -> port -> port (one level per hop). Every
// segment starts with no arrowhead; the caller sets the head on the touch segment.
//
// `owner` is the node/container whose enclosing containers the chain climbs. For
// a plain node it equals `endpointId`. For a declared `port` it is the port's
// CONTAINER, not the port id: the port already sits on that container's boundary
// (it IS that level's exit), so the chain climbs from the container's parent
// outward — a routing port on each ancestor, never a redundant one on the port's
// own container. This lets a port nested below the LCA still chain up to it.
//
// `seedIsPort` marks an endpoint that is a fixed port (a declared `port`), so a
// chainless side (depth 0) anchors on the port point rather than a box.
function planChain(
  prefix: string,
  endpointId: string,
  owner: string,
  depth: number,
  nestingDistance: number,
  side: Side,
  seedIsPort = false,
): ChainPlan {
  const reachesLca = depth === nestingDistance;
  if (depth <= 0) {
    return {
      ports: [],
      segments: [],
      endpoint: endpointId,
      anchor: seedIsPort ? { kind: 'port', portId: endpointId } : { kind: 'box', id: endpointId },
      reachesLca,
    };
  }
  const ports: PortSpec[] = [];
  const segments: Segment[] = [];
  let from = endpointId;
  enclosingContainers(owner, depth).forEach((containerId, level) => {
    const portId = `${prefix}p${level}`;
    ports.push({ containerId, portId, side });
    segments.push({ id: `${prefix}${level}`, from, to: portId, container: containerId, arrow: 'none' });
    from = portId;
  });
  return {
    ports,
    segments,
    endpoint: from,
    anchor: { kind: 'port', portId: from },
    reachesLca,
  };
}

// Decides how to route one line. Pure: the renderer supplies the graph facts and
// applies the result. See docs/routing.md for the model.
//
// A declared-`port` endpoint is not a separate case: it is just an endpoint whose
// anchor is pre-pinned. `*Owner` carries its nesting (the port's container),
// `*Fixed` marks it as a fixed anchor that grows no routing ports of its own — the
// OTHER side chains to meet it. So port lines take the same plain/flatten/manual
// path as node lines, with one twist: a fixed side is pinned at depth 0.
export function planRoute(input: RouteInput): RoutePlan {
  const { sourceId, targetId, lca, lcaDir, lineType, routing, uniform, connId } = input;
  const sourceOwner = input.sourceOwner ?? sourceId;
  const targetOwner = input.targetOwner ?? targetId;
  const sourceFixed = input.sourceFixed ?? false;
  const targetFixed = input.targetFixed ?? false;

  // Crossing and nesting are measured on the OWNER (a node, or a declared port's
  // container); the ELK anchor stays the id (the port id for a declared port).
  const crosses = parentId(sourceOwner) !== lca || parentId(targetOwner) !== lca;
  if (!crosses) return { kind: 'plain', warnRoute: routing != null };
  if (uniform) return { kind: 'flatten' };

  const srcND = segCount(sourceOwner) - segCount(lca) - 1;
  const tgtND = segCount(targetOwner) - segCount(lca) - 1;
  const requested = routing
    ? routing.depth === 'auto'
      ? Number.POSITIVE_INFINITY
      : routing.depth ?? 1
    : 0;
  // A fixed (declared) port is pinned at depth 0 — it never grows routing ports of
  // its own; the free side chains toward it and honors the requested depth
  // (default 0 → a hand-drawn bridge to the port point, as for a node endpoint).
  const depthSrc = sourceFixed ? 0 : Math.max(0, Math.min(requested, srcND));
  const depthTgt = targetFixed ? 0 : Math.max(0, Math.min(requested, tgtND));
  const bend = routing ? routing.bend ?? 'auto' : undefined;

  const exitSide = resolveExitSide(routing?.exit, sourceOwner, targetOwner, lca, lcaDir);
  const enterSide = resolveEnterSide(routing?.enter, exitSide);
  const source = planChain(`${connId}s`, sourceId, sourceOwner, depthSrc, srcND, exitSide, sourceFixed);
  const target = planChain(`${connId}t`, targetId, targetOwner, depthTgt, tgtND, enterSide, targetFixed);

  // A fixed port is pinned to a real border edge; the bridge must attach along that
  // edge (its axis drives the z/n/L choice in orthogonalPoints), not along the auto
  // exit/enter side the flow direction produced. A free (non-fixed) side keeps the
  // resolved side, which is also where its chain's outer port was placed.
  const joinExitSide = sourceFixed && input.sourcePortSide ? input.sourcePortSide : exitSide;
  const joinEnterSide = targetFixed && input.targetPortSide ? input.targetPortSide : enterSide;

  // The head sits on whichever segment touches the line's arrow end. A chain's
  // touch segment runs endpoint -> port, so the endpoint is that polyline's START
  // point; hence a head there is `start`. When a side has no chain, the head goes
  // on the joining segment (below), whose orientation puts source at its start and
  // target at its end.
  const srcTouch = source.segments[0]; // present iff depthSrc >= 1
  const tgtTouch = target.segments[0];
  if (lineType === '-->' && tgtTouch) tgtTouch.arrow = 'start';
  if (lineType === '<--' && srcTouch) srcTouch.arrow = 'start';

  const joinArrow: ArrowEnd =
    lineType === '-->' && !tgtTouch ? 'end' : lineType === '<--' && !srcTouch ? 'start' : 'none';

  const join: JoinPlan =
    source.reachesLca && target.reachesLca
      ? { kind: 'elk', id: `${connId}j`, from: source.endpoint, to: target.endpoint, container: lca, arrow: joinArrow }
      : { kind: 'bridge', from: source.anchor, to: target.anchor, arrow: joinArrow, bend, exitSide: joinExitSide, enterSide: joinEnterSide };

  return { kind: 'manual', source, target, join };
}
