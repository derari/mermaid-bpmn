import type { Direction, LineType, RouteSpec, Side } from './model.js';
import { constrainsRouting } from './model.js';

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

// The id of the branch — the child of `lca` — on the dot-path to `id`, or '' when
// `id` IS the lca (no branch to compare). The geometric counterpart of
// branchIndexUnderLca: the box this id sits in, as laid out.
export function branchUnderLca(id: string, lca: string): string {
  if (id === lca) return '';
  const segs = id.split('.');
  const n = segCount(lca) + 1;
  return n <= segs.length ? segs.slice(0, n).join('.') : id;
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

// ---- flatten analysis (which container to flatten, and what to black-box) ----

// The minimal tree shape analyzeFlatten needs (an ElkNode satisfies it).
export interface DirNode {
  id: string;
  children?: DirNode[];
}

// The minimal direction lookup analyzeFlatten needs — a `Map<string, Direction>`
// satisfies it, and so does an adapter's `{ get }` shim.
export interface DirLookup {
  get(id: string): Direction | undefined;
}

// The AUTHOR-DECLARED direction of a container (undefined = inherit from parent).
// Distinct from DirLookup, which returns the resolved/normalized direction.
export interface ExplicitDirLookup {
  get(id: string): Direction | undefined;
}

// The normalized direction model: the effective direction of every container after
// collapsing single-child-chain shells, plus the set of containers that are genuine
// direction boundaries (must be SEPARATE_CHILDREN / black-boxed).
export interface DirModel {
  dir: Map<string, Direction>; // normalized effective direction per container id
  separate: Set<string>; // container ids that are direction boundaries (black-boxes)
}

// Normalizes container directions and decides the SEPARATE (black-box) set in ONE
// global pre-pass, so the boundary notion is single-sourced (see docs/routing.md).
//
// A container's declared direction is only VISIBLE when it BRANCHES — has 2+ box
// children whose arrangement the direction fixes. A single-child-chain shell's
// direction is invisible (one child, or a chain of them, looks the same either way),
// so a differing direction is pushed DOWN the chain to the first branching container;
// that container, if its direction still differs from its (normalized) parent, is the
// real boundary → SEPARATE. Everything else stays flattenable.
//
// Per the algorithm (docs/routing.md): a child `W` differing from parent `P` is a
// SEPARATE *candidate*; if `W` is a shell (≤1 box child) AND that child is also a
// shell (≤1 box child), `W` normalizes to `P` and its direction pushes down to the
// child (recurse); otherwise `W` is SEPARATE. `explicitDir` gives author-declared
// directions (undefined = inherit). Pure; the tree is any DirNode (ElkNode satisfies).
export function normalizeDirections(
  root: DirNode,
  explicitDir: ExplicitDirLookup,
  rootDir: Direction,
): DirModel {
  const dir = new Map<string, Direction>();
  const separate = new Set<string>();
  const boxChildren = (n: DirNode): DirNode[] => n.children ?? [];
  const isContainer = (n: DirNode): boolean => boxChildren(n).length > 0;

  // Resolve one container `W`. `parentDir` is its normalized parent's direction;
  // `inheritedDir` is the direction `W` takes when it declares none — normally the
  // parent's, but a collapsed shell pushes its OWN direction down as its child's.
  const resolve = (W: DirNode, parentDir: Direction, inheritedDir: Direction): void => {
    const wDir = explicitDir.get(W.id) ?? inheritedDir;
    const kids = boxChildren(W);
    if (wDir === parentDir) {
      // Same direction — transparent, never a boundary. Recurse normally.
      dir.set(W.id, wDir);
      for (const c of kids) if (isContainer(c)) resolve(c, wDir, wDir);
      return;
    }
    // Differs from parent → SEPARATE candidate. Collapsible iff `W` is a shell (≤1 box
    // child) AND that child is itself a shell (≤1 box child): the differing direction
    // is invisible here, so it pushes down the chain.
    const x = kids.length === 1 ? kids[0] : undefined;
    const collapsible = kids.length <= 1 && (!x || boxChildren(x).length <= 1);
    if (collapsible) {
      dir.set(W.id, parentDir); // normalize away (invisible)
      if (x && isContainer(x)) resolve(x, parentDir, wDir); // push wDir down
      return;
    }
    // Genuine branching boundary → SEPARATE, keeps its direction.
    dir.set(W.id, wDir);
    separate.add(W.id);
    for (const c of kids) if (isContainer(c)) resolve(c, wDir, wDir);
  };

  dir.set(root.id, rootDir);
  for (const c of boxChildren(root)) if (isContainer(c)) resolve(c, rootDir, rootDir);
  return { dir, separate };
}


// What a `flatten` line needs from the graph: which container to INCLUDE_CHILDREN,
// which descendants to keep opaque (SEPARATE_CHILDREN), and the corridor that must
// stay flattened (so the caller can protect it from being black-boxed by another
// line). `spine` IS the corridor — the containers the line threads through.
export interface FlattenPlan {
  container: string; // node to flatten (INCLUDE_CHILDREN) — the flatten root
  spine: string[]; // corridor: containers the line threads through — must stay INCLUDE
  blackBox: string[]; // direction boundaries off the corridor → SEPARATE
}
export interface FlattenInput {
  sourceOwner: string;
  targetOwner: string;
  sourceFixed: boolean;
  targetFixed: boolean;
  lca: string;
}

// Decides whether a boundary-crossing line can be routed by flattening, and if so
// with which root and which descendants black-boxed. Pure: the caller supplies node
// lookup and per-container directions (an ElkNode graph satisfies DirNode). Returns
// null when the line does not cross, or when a visible corridor container differs
// from the flatten direction (flattening would rotate it) — the caller then routes
// it manually. See docs/routing.md.
//
// The flatten root is normally the LCA; it is raised to the LCA's PARENT when a
// declared port sits ON the LCA and the other endpoint is nested below it, so the
// port's container becomes an intermediate node ELK can route to (a port on the
// flatten-root itself throws).
//
// The CORRIDOR (`spine`) is the containers the line threads through to reach the
// root. A NODE endpoint threads through its own container and up; a declared-PORT
// endpoint meets the line on its boundary, so the line does NOT enter the port's
// container — its corridor starts at the port container's PARENT. That is what lets
// an outward port line black-box its own container (it's not on the corridor), while
// a sibling line whose node endpoint IS inside that container still puts it on the
// corridor and protects it.
//
// The BLACK-BOX set is the SEPARATE containers off the corridor: descend the flatten
// root's subtree and cut at the first container in `separate` (a direction boundary
// per normalizeDirections), keeping that whole sub-region one opaque SEPARATE box;
// recurse through the rest. `separate` is the single global boundary set, so a
// container is never both flattened on a corridor and black-boxed.
export function analyzeFlatten(
  input: FlattenInput,
  nodeOf: (id: string) => DirNode | undefined,
  separate: Set<string>,
): FlattenPlan | null {
  const { sourceOwner, targetOwner, sourceFixed, targetFixed, lca } = input;
  const crosses = parentId(sourceOwner) !== lca || parentId(targetOwner) !== lca;
  if (!crosses) return null;

  const portOnLcaVsDeep =
    (sourceFixed && sourceOwner === lca && parentId(targetOwner) !== lca) ||
    (targetFixed && targetOwner === lca && parentId(sourceOwner) !== lca);
  const container = portOnLcaVsDeep ? parentId(lca) : lca;

  // The corridor: for each endpoint, the containers up to (excluding) the root. A
  // declared-port endpoint starts ABOVE its container (the line meets the port on
  // the boundary, not through the interior); a node endpoint starts at its own.
  const spine = new Set<string>();
  for (const [owner, fixed] of [
    [sourceOwner, sourceFixed],
    [targetOwner, targetFixed],
  ] as const) {
    let k = fixed ? parentId(owner) : owner;
    while (k !== container && k !== '') {
      spine.add(k);
      k = parentId(k);
    }
  }
  // Viability: no corridor container may be a direction boundary — we cannot black-box
  // a container the line threads through, so flattening would rotate it.
  for (const s of spine) {
    if (separate.has(s)) return null;
  }

  const root = nodeOf(container);
  if (!root) return null;
  const blackBox: string[] = [];
  const walk = (node: DirNode): void => {
    for (const child of node.children ?? []) {
      if (!spine.has(child.id) && separate.has(child.id)) blackBox.push(child.id);
      else walk(child);
    }
  };
  walk(root);
  return { container, spine: [...spine], blackBox };
}

// The minimal per-line facts analyzeInterior needs (owners + LCA, from the caller).
export interface InteriorLine {
  sourceOwner: string;
  sourceFixed: boolean;
  targetOwner: string;
  targetFixed: boolean;
  lca: string;
}

// Decides which black-box (SEPARATE) containers should get an INTERIOR WRAPPER — a
// synthetic INCLUDE region that flattens the black-box's uniform interior so lines route
// freely through it (one ELK edge spanning the flattened levels) instead of a port on
// each level. The wrapper keeps the interior containers INTERMEDIATE INCLUDE, so their
// ports stay valid, while the shell stays SEPARATE and keeps its direction.
//
// A black-box `W` is wrapped iff some line ENTERS a container-child of it — walking from a
// line endpoint up to (and including) its LCA, when a black-box is reached the child of it
// on that path is a container. This covers a line that EXITS `W` (endpoint deep inside a
// container-child) and an INTERNAL line whose LCA IS `W` (crossing between its container
// children). A line that only touches a leaf child needs no interior flatten. Pure; the
// caller supplies node lookup (an ElkNode graph satisfies DirNode). See docs/routing.md.
export function analyzeInterior(
  separate: Set<string>,
  lines: InteriorLine[],
  nodeOf: (id: string) => DirNode | undefined,
): Set<string> {
  const targets = new Set<string>();
  const isContainer = (id: string): boolean => {
    const n = nodeOf(id);
    return !!(n && n.children && n.children.length);
  };
  const consider = (owner: string, lca: string): void => {
    // Walk from the endpoint up to (and including) the LCA. At each black-box, wrap it
    // iff the child of it on this path is a container (the line enters a container-child).
    let prev = owner;
    for (let k = parentId(owner); ; k = parentId(k)) {
      if (separate.has(k) && isContainer(prev)) targets.add(k);
      if (k === lca || k === '') break;
      prev = k;
    }
  };
  for (const l of lines) {
    consider(l.sourceOwner, l.lca);
    consider(l.targetOwner, l.lca);
  }
  return targets;
}

// ---- exit side -----------------------------------------------------------

// The AXIS of an `auto` side comes from the LCA's flow direction, and its SIGN from
// `later` — whether the target's branch sits further along that flow than the
// source's. TB and LR run with increasing screen coordinates; BT and RL against them.
export function sideFromFlow(lcaDir: Direction, later: boolean): Side {
  if (lcaDir === 'TB' || lcaDir === 'BT') {
    return (lcaDir === 'TB' ? later : !later) ? 's' : 'n';
  }
  return (lcaDir === 'LR' ? later : !later) ? 'e' : 'w';
}

// A laid-out box, in absolute coordinates (the renderer's AbsRect satisfies this).
export interface LaidRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Two branch boxes count as "aligned" — neither later than the other — when their
// centres sit within this many pixels on the flow axis. Side-by-side branches (a
// cross-flow line) then keep whatever declaration order decided, rather than
// flipping on sub-pixel noise.
const FLOW_ALIGN_TOLERANCE = 1;

// Is the TARGET branch later than the SOURCE branch along the LCA's flow, judged by
// the actual laid-out boxes? Returns undefined when the two sit level on that axis
// (see FLOW_ALIGN_TOLERANCE), so the caller keeps its declaration-order answer.
// This is the geometric replacement for branchIndexUnderLca: ELK reorders siblings
// freely, so declaration order is only ever a pre-layout guess.
export function laterFromGeometry(
  lcaDir: Direction,
  source: LaidRect,
  target: LaidRect,
): boolean | undefined {
  const vertical = lcaDir === 'TB' || lcaDir === 'BT';
  const src = vertical ? source.y + source.h / 2 : source.x + source.w / 2;
  const tgt = vertical ? target.y + target.h / 2 : target.x + target.w / 2;
  const delta = tgt - src;
  if (Math.abs(delta) <= FLOW_ALIGN_TOLERANCE) return undefined;
  return lcaDir === 'TB' || lcaDir === 'LR' ? delta > 0 : delta < 0;
}

// The side of the source's container the line should leave from. An explicit
// side wins literally (even against the geometry — the line then loops around).
// A declared `port` endpoint pins the side next: the line physically meets that
// edge, so its side (hence its axis) is fixed regardless of the flow — this is
// what keeps a line to an e/w port bending HVH rather than following the LCA's
// flow. Otherwise `auto` takes its AXIS from the LCA's flow direction — a
// vertically-flowing LCA stacks its children top to bottom, so a line to another
// branch leaves north/south — and its SIGN from whether the target's branch sits
// later than the source's in that flow. That last comparison is declaration order
// before layout; `later` lets the post-layout correction supply the real one
// (see reorientAutoSides in the renderer).
export function resolveExitSide(
  exit: RouteSpec['exit'],
  sourceId: string,
  targetId: string,
  lca: string,
  lcaDir: Direction,
  portSide?: Side,
  later?: boolean,
): Side {
  if (exit && exit !== 'auto') return exit;
  if (portSide) return portSide;
  return sideFromFlow(
    lcaDir,
    later ?? branchIndexUnderLca(targetId, lca) > branchIndexUnderLca(sourceId, lca),
  );
}

// The side of the target's container the line enters on. An explicit side wins
// literally; a declared `port` endpoint pins it next (its edge is fixed, like the
// exit side above); `auto` (the default) otherwise faces the source's exit, i.e.
// the opposite of the resolved exit side — the original behaviour before `enter`
// existed.
export function resolveEnterSide(
  enter: RouteSpec['enter'],
  exitSide: Side,
  portSide?: Side,
): Side {
  if (enter && enter !== 'auto') return enter;
  if (portSide) return portSide;
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
// A hand-drawn hop WITHIN a chain (not the source↔target join): the segment that
// crosses a black-box's interior WRAPPER, from a port on the wrapper's outermost
// INCLUDE child to a port on the black-box shell. ELK cannot route across a wrapper
// (and a port on the wrapper itself throws), so this hop is drawn. See docs/routing.md.
// `arrow` is 'none' unless this bridge IS the side's touch element (see planRoute) — e.g.
// the endpoint sits directly on the wrapper's outer child, so its very first crossing has
// no ELK segment to attach the head to; the bridge itself then carries it.
export interface ChainBridge {
  from: Anchor;
  to: Anchor;
  bend: 'z' | 'n' | 'l' | 'auto';
  exitSide: Side;
  enterSide: Side;
  arrow: ArrowEnd;
}
// One side of a manual route: the port chain climbing out of an endpoint.
export interface ChainPlan {
  ports: PortSpec[]; // innermost first
  segments: Segment[]; // endpoint -> port -> port …, ELK edges
  bridges: ChainBridge[]; // hand-drawn wrapper crossings within this side (usually empty)
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
      // Fully resolved before layout: `auto` when the line requested no explicit
      // shape (an omitted `bend` is normalized to `auto`, never left undefined), so
      // the drawn bridge always has a concrete shape to honor.
      bend: 'z' | 'n' | 'l' | 'auto';
      // The resolved exit/enter sides, so the drawn bridge can shape an `l`
      // (source-edge orientation) and detect the 90° case that `auto` turns into
      // an `l`. The port-chain sides use these too, but the bridge geometry needs
      // them to pick HV vs VH.
      exitSide: Side;
      enterSide: Side;
    };

// The full verdict for one line.
//  - `plain`   both endpoints are direct children of the LCA → a normal ELK edge.
//              `warnRoute` flags a `route` that has nothing to tune here.
//  - `flatten` a boundary-crossing line the caller decided can be routed by ELK once
//              `container` flattens (INCLUDE_CHILDREN) and each id in `blackBox` is
//              kept opaque (SEPARATE_CHILDREN) so it keeps its own direction. The
//              caller computes this with analyzeFlatten (it needs the graph tree);
//              planRoute just packages it. See docs/routing.md.
//  - `manual`  a boundary-crossing line that cannot flatten (mixed spine) → port
//              chains joined at the LCA (ELK) or by a hand-drawn bridge.
export type RoutePlan =
  | { kind: 'plain'; warnRoute: boolean }
  | { kind: 'flatten'; container: string; blackBox: string[] }
  | {
      kind: 'manual';
      source: ChainPlan;
      target: ChainPlan;
      join: JoinPlan;
      // The sides every port and bridge above was oriented by. Reported so the
      // renderer can tell whether a post-layout re-resolution changed anything
      // (see reorientAutoSides).
      exitSide: Side;
      enterSide: Side;
    };

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
  // The pinned side of a declared-`port` endpoint (undefined for a node). It fixes
  // that end's exit/enter side — hence the bend axis — so a line to an e/w port
  // bends HVH and one to an n/s port VHV, instead of following the LCA's flow.
  sourcePortSide?: Side;
  targetPortSide?: Side;
  lca: string;
  lcaDir: Direction;
  lineType: LineType;
  routing: RouteSpec | undefined;
  // The caller's flatten verdict for this line (from analyzeFlatten, after resolving
  // cross-line conflicts): non-null → route by flattening `container` and black-boxing
  // its ids; null → the line cannot flatten, so planRoute routes it manually. A
  // non-crossing line is `plain` regardless (this is ignored there).
  flatten: { container: string; blackBox: string[] } | null;
  // The reconciled INCLUDE (flatten-root) and SEPARATE (black-box) node-id sets across
  // ALL lines. A manual chain's join can be an ELK edge — not a hand-drawn bridge — when
  // its topmost port is EXPOSED at the LCA: reached structurally, OR every container
  // between that port and the LCA is flattened (INCLUDE), so the boundary port shows
  // through. Optional; absent (or empty) → only a structural reach counts, as for a
  // plain diagram with no flattening. See docs/routing.md §4.
  include?: Set<string>;
  separate?: Set<string>;
  // Black-box ids whose interior is FLATTENED by a synthetic wrapper (analyzeInterior).
  // A side whose endpoint sits inside one exits via the wrapper cascade (one port on
  // the black-box's direct child + a bridge to a port on the shell) instead of a port
  // per level. Optional; absent → no wrappers (plain chains). See docs/routing.md.
  wrapped?: Set<string>;
  connId: string; // id prefix for generated ports/segments
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
  const { sourceId, targetId, lca, lcaDir, lineType, routing, flatten, connId } = input;
  const sourceOwner = input.sourceOwner ?? sourceId;
  const targetOwner = input.targetOwner ?? targetId;
  const sourceFixed = input.sourceFixed ?? false;
  const targetFixed = input.targetFixed ?? false;

  // Crossing and nesting are measured on the OWNER (a node, or a declared port's
  // container); the ELK anchor stays the id (the port id for a declared port).
  const crosses = parentId(sourceOwner) !== lca || parentId(targetOwner) !== lca;
  // Warn only for a route that actually CONSTRAINS routing — a blanket `depth:auto`
  // (e.g. inherited from a diagram-wide `route`) is a no-op default and must not warn
  // on every non-crossing line.
  if (!crosses) return { kind: 'plain', warnRoute: constrainsRouting(routing) };
  // The caller already decided (via analyzeFlatten + cross-line conflict resolution)
  // whether this crossing line can flatten. If so, route it by flattening; otherwise
  // fall through to the manual port-chain / bridge planning below.
  if (flatten) return { kind: 'flatten', container: flatten.container, blackBox: flatten.blackBox };

  const srcND = segCount(sourceOwner) - segCount(lca) - 1;
  const tgtND = segCount(targetOwner) - segCount(lca) - 1;
  // A crossing line that reaches here did not flatten, so it needs a hand-drawn crossing.
  // The DEFAULT depth is 0 — a pure bridge, no auto-ports: ELK places a free port wherever
  // its own edge routing likes (often nowhere near what the port connects to) and can route
  // the resulting join in long squiggles, neither of which we can steer (see docs/routing.md
  // §4). A straight hand-drawn bridge is better on essentially every simple diagram.
  // `route depth:N`/`depth:auto` opts INTO the auto-port chain for the cases where threading
  // the boundary matters more than the shape — `auto` meaning "as many levels as it takes".
  const requested =
    routing?.depth === undefined
      ? 0
      : routing.depth === 'auto'
        ? Number.POSITIVE_INFINITY
        : routing.depth;

  // effInclude: is a container flattened (INCLUDE) once the reconciled sets (§2, §3)
  // are applied? exposedAtLca: does a port on `baseId`'s boundary show through to the
  // LCA — i.e. baseId is SEPARATE (its boundary exists) and every container between it
  // and the LCA is INCLUDE (a port ON the LCA counts). Used both to cap the chain and
  // to decide the join. See docs/routing.md §4.
  const wrapped = input.wrapped ?? new Set<string>();
  const effInclude = (nid: string): boolean => {
    for (let cur = nid; ; cur = parentId(cur)) {
      if (input.include?.has(cur)) return true;
      if (input.separate?.has(cur)) return false;
      if (cur === '') return true; // the diagram root is INCLUDE (flatten by default)
    }
  };
  const exposedAtLca = (baseId: string): boolean => {
    if (baseId === lca) return true; // a port ON the LCA is trivially reachable
    // NB: baseId's OWN hierarchy handling does not matter — a DECLARED port is a real anchor
    // whether its container is SEPARATE (a boundary port) or INCLUDE (an intermediate-node
    // port, valid as long as an INCLUDE ancestor sits above it, which the LCA provides). What
    // decides reachability is only the path ABOVE it: all-INCLUDE and no wrapper → the port
    // shows through to an ELK edge at the LCA.
    for (let cur = parentId(baseId); cur !== lca; cur = parentId(cur)) {
      if (cur === '') return false; // walked past the LCA without an INCLUDE bridge
      // A WRAPPER region on the path (its parent is a wrapped black-box) hides the port
      // from the LCA: ELK cannot route from inside a wrapper out to the shell it wraps,
      // so an ELK join would silently drop. The line must BRIDGE instead. (Mirrors the
      // node-endpoint reachesLca guard below.)
      if (wrapped.has(parentId(cur))) return false;
      if (!effInclude(cur)) return false;
    }
    return true;
  };
  // Resolve the bend shape once, here at the boundary between inheritance and layout:
  // an omitted `bend` becomes `auto`. Both `depth` and `bend` default the same way
  // whether or not a `route` is present — an all-default `route` (e.g. a diagram-wide
  // `depth:auto`) routes identically to no `route`. Only an explicit numeric `depth`
  // caps the chain (`depth:0` → a pure bridge); everything else follows the auto path.
  const bend = routing?.bend ?? 'auto';

  const exitSide = resolveExitSide(
    routing?.exit,
    sourceOwner,
    targetOwner,
    lca,
    lcaDir,
    input.sourcePortSide,
  );
  const enterSide = resolveEnterSide(routing?.enter, exitSide, input.targetPortSide);
  // Plan one side out to the LCA. Walk its enclosing containers innermost-first and SKIP
  // the flat (INCLUDE) ones — ELK spans them in a single edge — porting ONLY the SEPARATE
  // black-box shells it crosses, up to `requested` crossings. A plain black-box gets one
  // ELK hop to a port on its shell; a WRAPPED black-box (its interior flattened) gets a
  // port on the wrapper's child (an intermediate INCLUDE node reached in one ELK edge) +
  // a hand-drawn BRIDGE over the wrapper to a port on the shell. A fixed (declared-port)
  // side is pinned and grows no ports. See docs/routing.md §4.
  const planSide = (
    prefix: string,
    id: string,
    owner: string,
    nd: number,
    side: Side,
    fixed: boolean,
  ): ChainPlan => {
    const ports: PortSpec[] = [];
    const segments: Segment[] = [];
    const bridges: ChainBridge[] = [];
    let from = id;
    let anchor: Anchor = fixed ? { kind: 'port', portId: id } : { kind: 'box', id };
    // The container the current `from` anchor is a port ON (null while `from` is still
    // the raw endpoint). Lets a wrapper cascade tell whether the wrapper's child on the
    // path was ALREADY ported by an inner crossing — a nested black-box — so it reuses
    // that port instead of stacking a second one on the same boundary.
    let fromPortContainer: string | null = null;
    let brokeEarly = false;
    // Both node and fixed-port sides walk out: a declared port DEEP inside a black-box
    // must still cascade out (its own boundary is not exposed at the LCA). A fixed port
    // that is directly exposed simply finds no SEPARATE on its path and stays pinned.
    {
      const encl = enclosingContainers(owner, nd);
      let crossed = 0;
      for (let i = 0; i < encl.length; i++) {
        const C = encl[i];
        // A WRAPPER region whose parent (a wrapped black-box) IS the LCA: the endpoint sits
        // inside that wrapper and must exit to the shell/LCA level, where the other side
        // waits (typically a declared port on the shell). ELK cannot cross a wrapper, so
        // plant ONE auto-port on the wrapper's outermost child encl[i-1] — the INCLUDE
        // child of the separate shell — ELK-route the endpoint to it (one edge spanning the
        // flattened interior), then BRIDGE over the wrapper via the join. If that child is a
        // nested black-box the walk ALREADY ported (fromPortContainer), or the endpoint sits
        // directly in the wrapper (i===0), reuse the current anchor and bridge straight — no
        // duplicate port. This is the shell-is-LCA twin of the `wrapped.has(C)` cascade
        // below (there the shell sits under the LCA and also gets its own shell port).
        if (wrapped.has(parentId(C)) && parentId(C) === lca) {
          if (crossed < requested) {
            const X = i >= 1 ? encl[i - 1] : null;
            if (X && fromPortContainer !== X) {
              const xp = `${prefix}x${crossed}`;
              ports.push({ containerId: X, portId: xp, side });
              segments.push({ id: `${prefix}e${crossed}`, from, to: xp, container: X, arrow: 'none' });
              from = xp;
              anchor = { kind: 'port', portId: xp };
              fromPortContainer = X;
              crossed++;
            }
          }
          // brokeEarly forces the OUTER join itself to bridge, from `anchor` (still the raw
          // endpoint when X was never taken) — so an endpoint-touching arrow lands there
          // correctly; no bridge is created here to carry it.
          brokeEarly = true; // the join must bridge over the wrapper to reach the shell/LCA
          break;
        }
        if (effInclude(C)) continue; // flat — ELK spans it, no port
        if (crossed >= requested) {
          brokeEarly = true; // budget spent → the join bridges the remaining gap
          break;
        }
        const wp = `${prefix}w${crossed}`; // port on the black-box shell C
        if (wrapped.has(C)) {
          // C's interior is flattened by the wrapper region encl[i-1]; attach on the
          // wrapper's child encl[i-2] (an intermediate INCLUDE node) via one ELK edge,
          // then BRIDGE over the wrapper to the shell port. But if that child was ALREADY
          // ported by an inner crossing (it is itself a nested black-box, so `from` is a
          // port already on it) — or the endpoint is the wrapper's child with nothing
          // deeper — bridge straight from the current anchor: a second port on the same
          // boundary (and the zero-length attach segment to it) is redundant.
          const X = i >= 2 ? encl[i - 2] : null;
          if (X && fromPortContainer !== X) {
            const xp = `${prefix}x${crossed}`;
            ports.push({ containerId: X, portId: xp, side });
            segments.push({ id: `${prefix}e${crossed}`, from, to: xp, container: X, arrow: 'none' });
            // This bridge crosses the wrapper BETWEEN two already-placed ports (xp, wp) — it
            // never touches the raw endpoint (the segment above does), so it never carries
            // the head.
            bridges.push({ from: { kind: 'port', portId: xp }, to: { kind: 'port', portId: wp }, bend, exitSide: side, enterSide: side, arrow: 'none' });
          } else {
            // No intermediate node between the endpoint and the wrapper (or it was already
            // ported by a nested black-box crossing): this bridge runs straight from the
            // CURRENT anchor. When crossed === 0 that anchor is still the raw endpoint — the
            // side's very first (and only) touch element, with no segment to carry the head
            // instead — so this bridge may need the arrow; planRoute decides after the loop
            // (srcTouch/tgtTouch below fall back to bridges[0] when segments is empty).
            bridges.push({ from: anchor, to: { kind: 'port', portId: wp }, bend, exitSide: side, enterSide: side, arrow: 'none' });
          }
          ports.push({ containerId: C, portId: wp, side });
        } else {
          ports.push({ containerId: C, portId: wp, side });
          segments.push({ id: `${prefix}s${crossed}`, from, to: wp, container: C, arrow: 'none' });
        }
        from = wp;
        anchor = { kind: 'port', portId: wp };
        fromPortContainer = C;
        crossed++;
      }
    }
    // Exposed at the LCA (ready for an ELK join)? Yes unless the budget stopped us short
    // of the outermost black-box. With no ports, the endpoint must be directly reachable
    // — a fixed port whose boundary shows through, or a node in a flat region up to the LCA.
    let reachesLca: boolean;
    if (brokeEarly) reachesLca = false;
    else if (ports.length) reachesLca = true;
    else if (fixed) reachesLca = exposedAtLca(owner);
    else {
      reachesLca = true;
      for (let k = parentId(owner); k !== lca; k = parentId(k)) {
        // Not directly reachable if a container on the path is SEPARATE (a real boundary)
        // OR is a WRAPPER region (its parent is a wrapped black-box): ELK cannot route
        // across a wrapper, so the endpoint is behind it and the join must BRIDGE. Without
        // this, an internal line to a port on the wrapped black-box's OWN shell would emit
        // an ELK join that ELK silently drops.
        if (k === '' || !effInclude(k) || wrapped.has(parentId(k))) {
          reachesLca = false;
          break;
        }
      }
    }
    return { ports, segments, bridges, endpoint: from, anchor, reachesLca };
  };
  const source = planSide(`${connId}s`, sourceId, sourceOwner, srcND, exitSide, sourceFixed);
  const target = planSide(`${connId}t`, targetId, targetOwner, tgtND, enterSide, targetFixed);

  // The head sits on whichever element touches the line's arrow end. A chain's touch
  // element runs endpoint -> port, so the endpoint is that polyline's START point; hence a
  // head there is `start`. It is normally the side's first SEGMENT — but when the endpoint
  // sits directly on a wrapper's outer child (no intermediate node to ELK-route through),
  // the side's cascade creates ONLY a bridge for that first crossing (see planSide's
  // `wrapped.has(C)` branch): segments stays empty, so that bridge is the true touch
  // element instead. When a side has no chain at all, the head goes on the joining
  // segment (below), whose orientation puts source at its start and target at its end.
  const srcTouch = source.segments[0] ?? source.bridges[0]; // present iff depthSrc >= 1
  const tgtTouch = target.segments[0] ?? target.bridges[0];
  if (lineType === '-->' && tgtTouch) tgtTouch.arrow = 'start';
  if (lineType === '<--' && srcTouch) srcTouch.arrow = 'start';

  const joinArrow: ArrowEnd =
    lineType === '-->' && !tgtTouch ? 'end' : lineType === '<--' && !srcTouch ? 'start' : 'none';

  // The two sides ELK-join at the LCA when both are exposed there (planSide's reachesLca
  // already folds in the port-exposure and budget checks); else a hand-drawn bridge
  // closes the gap between their anchors.
  const srcExposed = source.reachesLca;
  const tgtExposed = target.reachesLca;

  const join: JoinPlan =
    srcExposed && tgtExposed
      ? { kind: 'elk', id: `${connId}j`, from: source.endpoint, to: target.endpoint, container: lca, arrow: joinArrow }
      : { kind: 'bridge', from: source.anchor, to: target.anchor, arrow: joinArrow, bend, exitSide, enterSide };

  return { kind: 'manual', source, target, join, exitSide, enterSide };
}
