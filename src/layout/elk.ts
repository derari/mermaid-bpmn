// Agnostic ELK graph helpers AND the routing engine: container layout options, the
// invisible ordering edges, and the whole-graph flatten/black-box/chain reconciliation
// (addConnections + survivingFlattens + applyManualRoute). Diagram-agnostic — it works
// against ELK node ids and a small `RouteAdapter` the diagram style supplies (endpoint
// resolution, per-line style, label writing). See docs/routing.md.
import type { ElkNode } from 'elkjs/lib/elk.bundled.js';
import type { Direction, LineType, RouteSpec, Side } from './model.js';
import { constrainsRouting } from './model.js';
import type { ConnStyle, LabelableEdge, ManualEdge, StraightEdge } from './edges.js';
import {
  type ArrowEnd,
  type ChainPlan,
  type FlattenPlan,
  type JoinPlan,
  type PortSpec,
  analyzeFlatten,
  planRoute,
} from './routePlan.js';

// Our layout directions mapped to ELK's flow-direction vocabulary.
export const ELK_DIRECTION: Record<Direction, string> = {
  TB: 'DOWN',
  BT: 'UP',
  LR: 'RIGHT',
  RL: 'LEFT',
};

// A compass side mapped onto ELK's port-side vocabulary.
export const ELK_PORT_SIDE: Record<Side, string> = {
  n: 'NORTH',
  e: 'EAST',
  s: 'SOUTH',
  w: 'WEST',
};

export function padding(top: number, left: number, bottom: number, right: number): string {
  return `[top=${top},left=${left},bottom=${bottom},right=${right}]`;
}

// The ELK options a container node carries: layered layout in its own flow
// direction, uniform node spacing, and padding (a taller top band reserves room
// for a heading). `topPad`/`sidePad`/`nodeSpacing` are supplied by the caller so
// no diagram-specific sizing is baked in here.
export function containerOptions(
  direction: Direction,
  topPad: number,
  sidePad: number,
  nodeSpacing: number,
): Record<string, string> {
  return {
    'elk.algorithm': 'layered',
    'elk.direction': ELK_DIRECTION[direction],
    'elk.spacing.nodeNode': String(nodeSpacing),
    'elk.layered.spacing.nodeNodeBetweenLayers': String(nodeSpacing),
    'elk.padding': padding(topPad, sidePad, sidePad, sidePad),
    // this doesnt seem to hurt, but in some cases it makes lines more stable
    'org.eclipse.elk.layered.unnecessaryBendpoints': 'true',
  };
}

// Invisible edges A->B->C to force reading order along the flow direction.
export function chainEdges(
  prefix: string,
  children: ElkNode[],
): { id: string; sources: string[]; targets: string[] }[] {
  const edges = [];
  for (let i = 1; i < children.length; i++) {
    edges.push({
      id: `${prefix}.e${i}`,
      sources: [children[i - 1].id],
      targets: [children[i].id],
    });
  }
  return edges;
}

// Drops the invisible ordering edges (see chainEdges) that a real connection has
// made redundant: an ordering edge survives only if neither of its endpoints ended
// up connected. Real connection edges (ids starting `conn`) are always kept.
export function pruneOrderingEdges(node: ElkNode, connected: Set<string>): void {
  if (node.edges) {
    node.edges = node.edges.filter(
      (edge) =>
        edge.id.startsWith('conn') ||
        (!connected.has(edge.sources[0]) && !connected.has(edge.targets[0])),
    );
  }
  for (const child of node.children ?? []) pruneOrderingEdges(child, connected);
}

// ---- the routing engine ----------------------------------------------------

// One resolved line endpoint (the diagram style supplies these). `elk` is the id an
// edge attaches to (a node, or a declared-port id); `owner` is the node id that
// governs the edge's LCA (the node itself, or a port's container); `side` pins a
// declared port's edge. (The style's own richer endpoint may carry more; the engine
// reads only these.)
export interface EndpointRef {
  elk: string;
  owner: string;
  isPort: boolean;
  side?: Side;
}

// A line the engine routes, fully resolved by the diagram style: endpoints, their
// LCA, the line kind + routing config, an optional caption, and the resolved draw
// style. `describe` is a human string for the "route does nothing" warning.
export interface RouteLine {
  id: string;
  source: EndpointRef;
  target: EndpointRef;
  lca: string;
  lineType: LineType;
  routing: RouteSpec | null;
  label?: string;
  style: ConnStyle;
  describe: string;
}

// The diagram-specific operations the engine calls back into: node/direction lookup
// by id, and writing a caption onto an ELK edge (measured in the style's own font).
export interface RouteAdapter {
  nodeById(id: string): ElkNode | undefined;
  dirById(id: string): Direction | undefined;
  applyEdgeLabel(edge: LabelableEdge, text: string): void;
}

// What the connection pass hands back: how to draw each ELK-routed edge (keyed by
// edge id), the node ids that ended up with at least one such edge, the containers to
// flatten (INCLUDE_CHILDREN) and to black-box (SEPARATE_CHILDREN), and the edges we
// draw ourselves (hand-drawn bridges and straight comment lines).
export interface Connections {
  styles: Map<string, ConnStyle>;
  connected: Set<string>;
  hierarchyContainers: Set<ElkNode>;
  blackBoxContainers: Set<ElkNode>;
  manualEdges: ManualEdge[];
  straightEdges: StraightEdge[];
  // Every direction-boundary id to OUTLINE under the debug overlay (broader than the
  // explicitly SEPARATE_CHILDREN black-boxes). See addConnections.
  debugSeparate: Set<string>;
}

// Reconciles the flatten candidates to a maximal consistent set. Two flatten lines
// CONFLICT when one's black-box (a node it needs SEPARATE) lands on the other's
// corridor — root + spine, the nodes that line needs INCLUDE. One node can't be both,
// and demoting EITHER line resolves it (a manual line black-boxes nothing and imposes
// no corridor), so the conflicts form an undirected graph and the survivors are a
// maximum independent set — equivalently, we demote a minimum vertex cover.
//
// Greedily demote the line in the MOST conflicts until none remain. This matters when
// one line's corridor blocks several others' black-boxes (a "star"): demoting that one
// centre costs a single manual bridge, whereas a rule that only ever demoted a
// black-boxing line — never the protector at the centre — would demote every leaf.
//
// Ties (equal conflict count) break toward the line with the LARGER black-box, then by
// id. That keeps the policy the XOR relies on: a shared port's interior line (needs its
// container INCLUDE, black-boxes nothing) and its exterior line (black-boxes that
// container) conflict one-to-one; demoting the larger black-box drops the exterior line,
// so the interior one wins. A demoted line leaves the graph, so this re-runs to a
// fixpoint. Returns the ids that keep flattening.
export function survivingFlattens(candidates: { id: string; flatten: FlattenPlan }[]): Set<string> {
  const surviving = new Set(candidates.map((c) => c.id));
  const byId = new Map(candidates.map((c) => [c.id, c.flatten] as const));
  const corridorOf = new Map(
    candidates.map((c) => [c.id, new Set([c.flatten.container, ...c.flatten.spine])] as const),
  );
  const conflicts = (a: string, b: string): boolean => {
    const fa = byId.get(a);
    const fb = byId.get(b);
    const ca = corridorOf.get(a);
    const cb = corridorOf.get(b);
    if (!fa || !fb || !ca || !cb) return false;
    return fa.blackBox.some((x) => cb.has(x)) || fb.blackBox.some((x) => ca.has(x));
  };
  for (;;) {
    const ids = [...surviving].sort();
    let worst: string | null = null;
    let worstKey: [number, number, string] | null = null;
    for (const a of ids) {
      const degree = ids.filter((b) => b !== a && conflicts(a, b)).length;
      if (degree === 0) continue;
      // Higher degree wins; tie → larger black-box; tie → later id (so lower id is kept).
      const key: [number, number, string] = [degree, byId.get(a)?.blackBox.length ?? 0, a];
      if (
        !worstKey ||
        key[0] > worstKey[0] ||
        (key[0] === worstKey[0] && key[1] > worstKey[1]) ||
        (key[0] === worstKey[0] && key[1] === worstKey[1] && key[2] > worstKey[2])
      ) {
        worst = a;
        worstKey = key;
      }
    }
    if (!worst) break; // no conflicts left
    surviving.delete(worst);
  }
  return surviving;
}

// Turns each resolved line into a real ELK edge (or a hand-drawn bridge). An edge must
// live in the LCA of its endpoints (ELK's rule for hierarchical edges). The flatten
// decision is a WHOLE-GRAPH question (INCLUDE/SEPARATE is one value per node, shared by
// every line): pass 1 asks analyzeFlatten whether each line *could* flatten; pass 2
// reconciles conflicts; pass 3 applies each line — flatten, plain ELK edge, or a chain
// (with a bridge fallback). See docs/routing.md.
export function addConnections(
  graph: ElkNode,
  lines: RouteLine[],
  adapter: RouteAdapter,
  diagramDirection: Direction,
  separate: Set<string>,
  interior: { wrapped: Set<string>; wrappers: Set<string> },
): Connections {
  const styles = new Map<string, ConnStyle>();
  const connected = new Set<string>();
  const hierarchyContainers = new Set<ElkNode>();
  const blackBoxContainers = new Set<ElkNode>();
  const manualEdges: ManualEdge[] = [];
  const straightEdges: StraightEdge[] = [];

  const nodeOf = (id: string): ElkNode | undefined => (id === '' ? graph : adapter.nodeById(id));

  interface LineInfo extends RouteLine {
    container: ElkNode;
    lcaDir: Direction;
    flatten: FlattenPlan | null;
  }
  const infos: LineInfo[] = [];
  for (const rl of lines) {
    const container = rl.lca === '' ? graph : adapter.nodeById(rl.lca);
    if (!container) continue;
    const lcaDir = rl.lca === '' ? diagramDirection : adapter.dirById(rl.lca) ?? diagramDirection;
    // A declared `port` endpoint is fed in as a fixed anchor; analyzeFlatten/planRoute
    // treat it as pinned at depth 0 and chain the other side to it. Flattening is tried
    // for EVERY crossing line regardless of any `route` directive: `route` only sets the
    // autoport BUDGET (`depth`) and shape (exit/enter/bend) used WHEN a line cannot
    // flatten — it never forces a manual chain, because a flattened line consumes no
    // budget. So `route depth:auto` (and even `depth:9999`) behaves exactly like no
    // route at all; behavior diverges only when a chain runs out of budget (§1, §4).
    const flatten = analyzeFlatten(
      {
        sourceOwner: rl.source.owner,
        targetOwner: rl.target.owner,
        sourceFixed: rl.source.isPort,
        targetFixed: rl.target.isPort,
        lca: rl.lca,
      },
      nodeOf,
      separate,
    );
    infos.push({ ...rl, container, lcaDir, flatten });
  }

  // Reconcile to a maximal consistent set of flatten lines; non-survivors chain.
  const surviving = survivingFlattens(
    infos.flatMap((info) => (info.flatten ? [{ id: info.id, flatten: info.flatten }] : [])),
  );

  // GLOBAL per-container hierarchy, set EXPLICITLY on every container (no reliance on ELK
  // inheritance). INCLUDE (flat) PROPAGATES down from the root through non-boundary
  // containers and STOPS at a direction boundary (the normalization `separate` set): a
  // boundary is SEPARATE_CHILDREN and keeps its own direction, and its children stay
  // SEPARATE too — so a declared/routing port on them is a valid boundary port, never a
  // throwing top-of-INCLUDE port. A synthetic WRAPPER region RE-OPENS the flow (INCLUDE)
  // inside a black-box so its uniform interior flattens. `wrapped` marks which black-boxes
  // have such a wrapper; `wrappers` are the wrapper region ids.
  const includeIds = new Set<string>(interior.wrappers); // effInclude short-circuits inside a wrapper
  const separateIds = new Set<string>(separate);
  const classify = (node: ElkNode, parentIncluded: boolean): void => {
    for (const child of node.children ?? []) {
      if (!child.children || child.children.length === 0) continue; // leaves: no hierarchy
      const included =
        !separate.has(child.id) && (parentIncluded || interior.wrappers.has(child.id));
      if (included) hierarchyContainers.add(child);
      else blackBoxContainers.add(child);
      classify(child, included);
    }
  };
  classify(graph, true); // the root graph is flat
  hierarchyContainers.add(graph);
  // Debug: outline every SEPARATE (SEPARATE_CHILDREN) container — the user's "every
  // SEPARATE node gets the marker".
  const debugSeparate = new Set<string>();
  for (const n of blackBoxContainers) debugSeparate.add(n.id);

  for (const info of infos) {
    const { source, target, lca, container, lcaDir, flatten, id, style } = info;
    const sourceId = source.elk;
    const targetId = target.elk;

    const flattenDecision =
      flatten && surviving.has(id)
        ? { container: flatten.container, blackBox: flatten.blackBox }
        : null;

    const plan = planRoute({
      sourceId,
      targetId,
      sourceOwner: source.owner,
      targetOwner: target.owner,
      sourceFixed: source.isPort,
      targetFixed: target.isPort,
      sourcePortSide: source.side,
      targetPortSide: target.side,
      lca,
      lcaDir,
      lineType: info.lineType,
      routing: info.routing ?? undefined,
      flatten: flattenDecision,
      include: includeIds,
      separate: separateIds,
      wrapped: interior.wrapped,
      connId: id,
    });

    // A line to a `text` (comment) is DRAWN as a straight segment between its boxes; it
    // still gets an INVISIBLE ELK edge (for connection-aware placement) unless its plan
    // is manual (whose chain would inflate the layout). A port endpoint or a CONSTRAINING
    // `route` (a non-default knob — not a blanket inherited `depth:auto`) opts back into
    // routing even for a text line.
    if (style.text && !source.isPort && !target.isPort && !constrainsRouting(info.routing)) {
      if (plan.kind !== 'manual') {
        (container.edges ??= []).push({ id, sources: [sourceId], targets: [targetId] });
        connected.add(sourceId);
        connected.add(targetId);
      }
      straightEdges.push({ sourceId, targetId, style, label: info.label });
      continue;
    }

    if (plan.kind === 'manual') {
      applyManualRoute(plan, style, adapter, container, styles, manualEdges, info.label);
      continue;
    }

    if (plan.kind === 'plain' && plan.warnRoute) {
      console.warn(`bpmn: route on ${info.describe} does nothing (it crosses no boundary)`);
    }

    const edge: LabelableEdge & { sources: string[]; targets: string[] } = {
      id,
      sources: [sourceId],
      targets: [targetId],
    };
    if (info.label !== undefined) adapter.applyEdgeLabel(edge, info.label);
    (container.edges ??= []).push(edge);
    styles.set(id, style);
    connected.add(sourceId);
    connected.add(targetId);
  }
  return {
    styles,
    connected,
    hierarchyContainers,
    blackBoxContainers,
    manualEdges,
    straightEdges,
    debugSeparate,
  };
}

// Applies a `manual` RoutePlan to the ELK graph: creates each planned port on its
// container (zero-size, FIXED_SIDE), adds each planned chain segment as an ELK edge,
// then adds the ELK join edge in the LCA or records the hand-drawn bridge. planRoute
// made every decision; this only mutates the graph.
function applyManualRoute(
  plan: { source: ChainPlan; target: ChainPlan; join: JoinPlan },
  style: ConnStyle,
  adapter: RouteAdapter,
  lcaContainer: ElkNode,
  styles: Map<string, ConnStyle>,
  manualEdges: ManualEdge[],
  label: string | undefined,
): void {
  // The caption rides the ELK edge nearest the SOURCE (TAIL keeps it source-side): the
  // source chain's touch segment, else the ELK join, else the target chain's. A pure
  // bridge (none of those) carries the label itself (carrierId undefined).
  const carrierId =
    plan.source.segments[0]?.id ??
    (plan.join.kind === 'elk' ? plan.join.id : undefined) ??
    plan.target.segments[0]?.id;

  // A line's END DECORATIONS (a message flow's origin circle, the slash ticks) belong to
  // one geometric endpoint each, so on a multi-piece route exactly one piece may draw
  // each. That piece is the side's TOUCH element — its first segment, or its first bridge
  // when the cascade produced only one (see planRoute's srcTouch/tgtTouch). A touch
  // element runs endpoint -> port, so the endpoint is its START point; hence a decoration
  // there is always a `start`. When a side grew no chain at all its endpoint sits on the
  // join instead, whose orientation puts the source at its start and the target at its end.
  const srcTouch = plan.source.segments[0] ?? plan.source.bridges[0];
  const tgtTouch = plan.target.segments[0] ?? plan.target.bridges[0];
  // The origin circle marks where the message ORIGINATES: the source end for `-->`/`---`,
  // the target end for `<--` (whose head sits at the source).
  const originIsSource = style.arrow !== 'start';
  const originTouch = originIsSource ? srcTouch : tgtTouch;
  const circleTouch = style.messageFlow ? originTouch : undefined;
  const joinCircle: 'start' | 'end' | undefined =
    style.messageFlow && !originTouch ? (originIsSource ? 'start' : 'end') : undefined;
  // The two slashes are placed the same way, but independently per end.
  const slashSrcTouch = style.slashStart ? srcTouch : undefined;
  const slashTgtTouch = style.slashEnd ? tgtTouch : undefined;
  const joinSlashStart = !!style.slashStart && !srcTouch;
  const joinSlashEnd = !!style.slashEnd && !tgtTouch;

  // The look every piece of this line shares (the variant and color), kept apart from the
  // per-piece decorations so a piece can never inherit an end mark that isn't its own.
  const shared = {
    invalid: style.invalid,
    text: style.text,
    stroke: style.stroke,
    messageFlow: style.messageFlow,
    dataAssoc: style.dataAssoc,
  };
  // The decorations THIS piece carries, by identity against the touch elements above.
  const decorate = (piece: unknown): Pick<ConnStyle, 'circle' | 'slashStart'> => ({
    circle: piece === circleTouch ? 'start' : undefined,
    slashStart: piece === slashSrcTouch || piece === slashTgtTouch,
  });

  const addPort = (p: PortSpec): void => {
    const container = adapter.nodeById(p.containerId);
    if (!container) return;
    (container.ports ??= []).push({
      id: p.portId,
      width: 0,
      height: 0,
      layoutOptions: { 'elk.port.side': ELK_PORT_SIDE[p.side] },
    });
    (container.layoutOptions ??= {})['elk.portConstraints'] = 'FIXED_SIDE';
  };
  const addSegment = (s: {
    id: string;
    from: string;
    to: string;
    container: string;
    arrow: ArrowEnd;
  }): void => {
    const container = adapter.nodeById(s.container);
    if (!container) return;
    const edge: LabelableEdge & { sources: string[]; targets: string[] } = {
      id: s.id,
      sources: [s.from],
      targets: [s.to],
    };
    if (label !== undefined && s.id === carrierId) adapter.applyEdgeLabel(edge, label);
    (container.edges ??= []).push(edge);
    styles.set(s.id, { arrow: s.arrow, ...shared, ...decorate(s) });
  };

  for (const p of plan.source.ports) addPort(p);
  for (const p of plan.target.ports) addPort(p);
  for (const s of plan.source.segments) addSegment(s);
  for (const s of plan.target.segments) addSegment(s);
  // Hand-drawn wrapper crossings within either chain (a black-box interior wrapper cannot
  // be ELK-routed across). Usually carries no head — but when the endpoint sits directly on
  // the wrapper's outer child, this bridge IS the side's touch element and planRoute has
  // marked it accordingly (see the srcTouch/tgtTouch selection there).
  for (const b of [...plan.source.bridges, ...plan.target.bridges]) {
    manualEdges.push({
      from: b.from,
      to: b.to,
      style: { arrow: b.arrow, ...shared, ...decorate(b) },
      bend: b.bend,
      exitSide: b.exitSide,
      enterSide: b.enterSide,
      label: undefined,
    });
  }

  if (plan.join.kind === 'elk') {
    const edge: LabelableEdge & { sources: string[]; targets: string[] } = {
      id: plan.join.id,
      sources: [plan.join.from],
      targets: [plan.join.to],
    };
    if (label !== undefined && plan.join.id === carrierId) adapter.applyEdgeLabel(edge, label);
    (lcaContainer.edges ??= []).push(edge);
    styles.set(plan.join.id, {
      arrow: plan.join.arrow,
      ...shared,
      circle: joinCircle,
      slashStart: joinSlashStart,
      slashEnd: joinSlashEnd,
    });
  } else {
    manualEdges.push({
      from: plan.join.from,
      to: plan.join.to,
      style: {
        arrow: plan.join.arrow,
        ...shared,
        circle: joinCircle,
        slashStart: joinSlashStart,
        slashEnd: joinSlashEnd,
      },
      bend: plan.join.bend,
      exitSide: plan.join.exitSide,
      enterSide: plan.join.enterSide,
      label: carrierId === undefined ? label : undefined,
    });
  }
}
