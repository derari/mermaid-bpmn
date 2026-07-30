import ELK, { type ElkNode } from 'elkjs/lib/elk.bundled.js';
import { type Direction, type Entity, type Line, type Side, db } from './db.js';
import { resolveBoundaryAutoSides } from './boundarySides.js';
import { analysePorts } from './portTypes.js';
import { commonAncestorId } from './geometry.js';
import {
  type Anchor,
  type ArrowEnd,
  analyzeInterior,
  normalizeDirections,
  resolveEnterSide,
  resolveExitSide,
} from './layout/routePlan.js';
import { type Resolved, resolveStyles } from './styleModel.js';
import { type IconSvg, resolveIcons } from './icons.js';
import { renderTheme } from './theme.js';
import { type AbsRect, orthogonalPoints } from './layout/geometry.js';
import { makeMeasurer } from './layout/text.js';
import {
  type ConnStyle,
  type ManualEdge,
  type Markers,
  collectAbsRects,
  createMarkers,
  drawEdgePolyline,
  drawEdges,
  drawLineLabelNearSource,
  drawStraightEdge,
} from './layout/edges.js';
import {
  type RouteAdapter,
  type RouteLine,
  ELK_PORT_SIDE,
  addConnections,
  chainEdges,
  containerOptions,
  pruneOrderingEdges,
} from './layout/elk.js';
import {
  type BuildCtx,
  CONTAINER_PAD,
  DEBUG_MANUAL_STROKE,
  type DrawCtx,
  EVENT_SIZE,
  LEAF_H,
  LEAF_MIN_W,
  NODE_SPACING,
  SUPPORTED_TYPES,
  TOGGLE_AXIS,
  applyEdgeLabel,
  collectLineEntities,
  drawBoundaryEvent,
  drawNode,
  equalisePoolLengths,
  gateClipper,
  lineStroke,
  poolOf,
  regionsFirst,
  resolveBracketSides,
  toElkNode,
} from './bpmnStyle.js';


const elk = new ELK();



function arrowFor(type: Line['type']): ArrowEnd {
  if (type === '-->') return 'end';
  if (type === '<--') return 'start';
  return 'none';
}

function endpointName(endpoint: Entity | string): string {
  if (typeof endpoint === 'string') return endpoint;
  return endpoint.name || '(unnamed)';
}

function describeLine(line: Line): string {
  return `"${endpointName(line.source)} ${line.type} ${endpointName(line.target)}"`;
}

// PROTOTYPE — auto-port alignment across a wrapper bridge.
//
// A wrapper crossing is hand-drawn between a port on the wrapped shell and a port on the
// wrapper's inner child. ELK cannot see the bridge (it is not an ELK edge), so it free-
// places each of those ports for the ELK edge it CAN see, and the two ends drift apart —
// the bridge comes out slanted or, when the two edges nearly coincide, degenerate.
//
// This pass runs after a first layout: for every hand-drawn bridge whose two ports sit on
// nodes in a containment relationship (a wrapper crossing — siblings are join bridges and
// are skipped), it nudges the AUTO port to share its counterpart's cross-axis position, so
// the bridge becomes a short straight hop. If one end is an EXPLICIT (declared) port it is
// the fixed reference and only the other (auto) port moves; if BOTH are explicit nothing
// moves (the author pinned them). It pins the moved port's container to FIXED_POS — every
// port already has a laid-out position, so the rest stay put — and signals a re-layout.
const ALIGN_BRIDGE_PORTS = true;

interface PortRef {
  port: { id: string; x?: number; y?: number };
  node: ElkNode;
  nodeAbs: AbsRect;
}
function indexPorts(node: ElkNode, ox: number, oy: number, out: Map<string, PortRef>): void {
  const x = ox + (node.x ?? 0);
  const y = oy + (node.y ?? 0);
  const nodeAbs: AbsRect = { x, y, w: node.width ?? 0, h: node.height ?? 0 };
  for (const port of (node as { ports?: { id: string; x?: number; y?: number }[] }).ports ?? []) {
    out.set(port.id, { port, node, nodeAbs });
  }
  for (const child of node.children ?? []) indexPorts(child, x, y, out);
}
// `anc` is a strict dot-path ancestor of `desc` (so `desc`'s node is nested in `anc`'s).
function isAncestorId(anc: string, desc: string): boolean {
  return desc.startsWith(`${anc}.`);
}
function alignBridgePorts(laid: ElkNode, manualEdges: ManualEdge[]): boolean {
  const ports = new Map<string, PortRef>();
  for (const child of laid.children ?? []) indexPorts(child, 0, 0, ports);
  const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
  let changed = false;
  for (const e of manualEdges) {
    if (e.from.kind !== 'port' || e.to.kind !== 'port') continue;
    const A = ports.get(e.from.portId);
    const B = ports.get(e.to.portId);
    if (!A || !B) continue;
    // Wrapper crossing iff one port's node contains the other's; else a sibling join bridge.
    const aInB = isAncestorId(B.node.id, A.node.id); // B outer, A inner
    const bInA = isAncestorId(A.node.id, B.node.id); // A outer, B inner
    if (!aInB && !bInA) continue;
    const inner = aInB ? A : B;
    const outer = aInB ? B : A;
    // Move the OUTER (shell) port onto the inner port's cross-axis, so the bridge is a short
    // straight hop. The shell contains the child, so this never clamps; a top-level shell is
    // positionally stable, so a FIXED_POS pin holds across the re-layout. (The inner port
    // can't be pinned the same way — it sits on a flattened INCLUDE node that shifts.)
    const side = e.exitSide ?? e.enterSide;
    const refX = inner.nodeAbs.x + (inner.port.x ?? 0);
    const refY = inner.nodeAbs.y + (inner.port.y ?? 0);
    const movX = outer.nodeAbs.x + (outer.port.x ?? 0);
    const movY = outer.nodeAbs.y + (outer.port.y ?? 0);
    // Skip a near-flush boundary (gap < 6px): aligning would collapse the bridge to a point.
    const alongGap = side === 'e' || side === 'w' ? Math.abs(movX - refX) : Math.abs(movY - refY);
    if (alongGap < 6) continue;
    const na = outer.nodeAbs;
    if (side === 'e' || side === 'w') {
      const relY = clamp(refY - na.y, 0, na.h);
      if (Math.abs((outer.port.y ?? 0) - relY) > 0.5) {
        outer.port.y = relY;
        (outer.node.layoutOptions ??= {})['elk.portConstraints'] = 'FIXED_POS';
        changed = true;
      }
    } else if (side === 'n' || side === 's') {
      const relX = clamp(refX - na.x, 0, na.w);
      if (Math.abs((outer.port.x ?? 0) - relX) > 0.5) {
        outer.port.x = relX;
        (outer.node.layoutOptions ??= {})['elk.portConstraints'] = 'FIXED_POS';
        changed = true;
      }
    }
  }
  return changed;
}

// Renders straight to the DOM (elkjs computes geometry; we own the SVG). Mermaid
// awaits an async draw, so we can await ELK's promise-based layout here.
export const renderer = {
  async draw(_text: string, id: string): Promise<void> {
    const svg = document.getElementById(id) as unknown as SVGSVGElement | null;
    if (!svg) {
      throw new Error(`bpmn: could not find svg element #${id}`);
    }

    const entities = db.getEntities();
    const direction = db.getDirection();
    // A root that holds pools stacks them ACROSS the diagram flow, exactly as a pool
    // stacks its lanes: the ELK layout direction toggles (TB↔LR, BT↔RL) while the pools
    // still inherit the original flow. Layout-only; `direction` (the inherited flow) is
    // unchanged. Everything downstream that reasons about the ROOT's layout — direction
    // normalization and the routing engine — must see the toggled value to match ELK.
    const rootHasPools = entities.some((e) => e.type === 'pool');
    const rootLayoutDir = rootHasPools ? TOGGLE_AXIS[direction] : direction;
    const { measure, done } = makeMeasurer(svg, 'bpmn-label');

    // Resolve every entity's fill/outline/icon once (classes, `style`, tint
    // inheritance, theme fallbacks) up front, since the build pass reads each
    // entity's icon to reserve room for it. Indexed by node id for the draw pass below.
    const theme = renderTheme();
    const resolved = resolveStyles(
      entities,
      db.getClassDefs(),
      db.getNamedStyles(),
      db.getNamedClasses(),
      theme,
      db.getRootStyle(),
    );

    const ctx: BuildCtx = {
      measure,
      types: new Map(),
      resolved,
      labelWidths: new Map(),
      topBandById: new Map(),
      idOf: new Map(),
      nodeById: new Map(),
      entityById: new Map(),
      byName: new Map(),
      dirById: new Map(),
      explicitDirById: new Map(),
      flowById: new Map(),
      eventOpById: new Map(),
      activityTypeById: new Map(),
      markerSpecsById: new Map(),
      dataTypeById: new Map(),
      ports: new Map(),
      declaredPortIds: new Set(),
      boundaryEvents: new Map(),
      // A boundary event's `auto` side and whether it carries a line are both needed
      // while SIZING its port, so they are resolved from the entity tree up front.
      boundaryAutoSide: resolveBoundaryAutoSides(db.getRoot(), direction, db.getLines()),
      lineEntities: collectLineEntities(db.getRoot(), db.getLines()),
      boundaryInsetById: new Map(),
      wrap: new Set(),
      wrapperIds: new Set(),
    };

    // Resolves a line endpoint (a name, or a direct entity reference for a relative
    // line) against the CURRENT build — both the pre-wrapper pass and the final routing
    // pass read the ctx maps as they stand at the time. A port endpoint resolves to its
    // ELK port and the container that owns it (which is what governs the LCA).
    type Endpoint = { elk: string; owner: string; isPort: boolean; side?: Side };
    const resolveEndpointOf = (endpoint: Entity | string): Endpoint | null => {
      const entity = typeof endpoint === 'string' ? ctx.byName.get(endpoint) : endpoint;
      if (!entity) return null;
      const port = ctx.ports.get(entity);
      if (port) {
        return { elk: port.portId, owner: port.containerId, isPort: true, side: port.side };
      }
      const nodeId = ctx.idOf.get(entity);
      if (!nodeId) return null;
      return { elk: nodeId, owner: nodeId, isPort: false };
    };

    // A line that attaches directly to a pool BOX gets its OWN port on that pool, so
    // ELK spreads several lines around the pool's boundary instead of stacking them at
    // one attachment point. The port is pinned to the side FACING the other endpoint
    // (its exit/enter side) but its POSITION on that side is left to ELK (FIXED_SIDE),
    // so multiple lines land at distinct points along the right edge. The endpoint then
    // behaves like a fixed anchor for routing (the other side chains to meet it). An
    // endpoint that is already a port has its own anchor and is left untouched.
    const poolPortEndpoint = (
      ref: Endpoint,
      connId: string,
      suffix: string,
      side: Side,
    ): Endpoint => {
      if (ref.isPort || ctx.types.get(ref.elk) !== 'pool') return ref;
      const pool = ctx.nodeById.get(ref.elk);
      if (!pool) return ref;
      const portId = `${connId}${suffix}pool`;
      (pool.ports ??= []).push({
        id: portId,
        width: 0,
        height: 0,
        layoutOptions: { 'elk.port.side': ELK_PORT_SIDE[side] },
      });
      (pool.layoutOptions ??= {})['elk.portConstraints'] = 'FIXED_SIDE';
      return { ...ref, elk: portId, isPort: true, side };
    };

    // Build the ELK tree from the entities. Every id-keyed ctx map is rebuilt from
    // scratch so the tree and its indexes stay consistent.
    const buildGraph = (): ElkNode => {
      for (const m of [
        ctx.types,
        ctx.labelWidths,
        ctx.topBandById,
        ctx.idOf,
        ctx.nodeById,
        ctx.entityById,
        ctx.byName,
        ctx.dirById,
        ctx.explicitDirById,
        ctx.flowById,
        ctx.eventOpById,
        ctx.activityTypeById,
        ctx.markerSpecsById,
        ctx.dataTypeById,
        ctx.ports,
        ctx.boundaryEvents,
        ctx.boundaryInsetById,
      ]) {
        m.clear();
      }
      ctx.declaredPortIds.clear();
      ctx.wrapperIds.clear();
      // Only supported families become nodes; the declaration index is kept in the id
      // even across skipped entities so ids stay unique and stable.
      const children: ElkNode[] = [];
      entities.forEach((entity, i) => {
        if (!SUPPORTED_TYPES.has(entity.type)) return;
        children.push(toElkNode(entity, `n${i}`, direction, ctx, true));
      });
      const rootOpts = containerOptions(rootLayoutDir, CONTAINER_PAD, CONTAINER_PAD, NODE_SPACING);
      if (rootHasPools) {
        // Pools are swimlanes: they must stack in a straight, aligned column (or row),
        // sharing a cross-axis origin regardless of the message flows running between
        // them. ELK's default node placement (Brandes-Köpf) shifts a pool sideways to
        // shorten those cross-pool edges, which breaks the alignment; SIMPLE placement
        // stacks each pool flush at the layer origin instead, so same-orientation pools
        // line up. Edges are still routed — just not at the cost of the stack.
        rootOpts['elk.layered.nodePlacement.strategy'] = 'SIMPLE';
      }
      const g: ElkNode = {
        id: 'root',
        layoutOptions: rootOpts,
        children,
        edges: [],
      };
      // Root ordering edges live alongside the top-level children.
      (g as { edges: unknown[] }).edges = chainEdges('root', children);
      return g;
    };

    let graph = buildGraph();
    // Direction-normalization pre-pass (pre-pass A): collapse single-child-chain shells
    // and pin the global SEPARATE (black-box) set. Captured per-ENTITY so it survives the
    // wrapper rebuild below, which shifts ids under a wrapped black-box.
    const dirModel = normalizeDirections(graph, ctx.explicitDirById, rootLayoutDir);
    const entityDir = new Map<Entity, Direction>();
    for (const [e, nodeId] of ctx.idOf) {
      const d = dirModel.dir.get(nodeId);
      if (d) entityDir.set(e, d);
    }
    // A POOL is ALWAYS a black-box, on top of whatever normalization decided. Not for
    // direction's sake — its toggled axis usually matches the root's, so normalization
    // sees no boundary — but because WE own a pool's geometry and ELK only honours that
    // for a node it lays out on its own: `equalisePoolLengths` pins a pool's length with
    // `elk.nodeSize.minimum`, and the root's SIMPLE node placement keeps the stack flush,
    // and BOTH are ignored once the pool's size comes from its parent's INCLUDE pass. So
    // a pool stays opaque and a line crossing into it is chained or bridged.
    const separateNodeIds = new Set(dirModel.separate);
    for (const [nodeId, type] of ctx.types) {
      if (type === 'pool') separateNodeIds.add(nodeId);
    }
    const separateEntities = new Set<Entity>();
    for (const nodeId of separateNodeIds) {
      const e = ctx.entityById.get(nodeId);
      if (e) separateEntities.add(e);
    }
    // Decide which black-boxes get an interior WRAPPER: resolve each line's owners on
    // this pre-wrapper tree and ask analyzeInterior. If any, mark those entities and
    // rebuild with synthetic INCLUDE regions (ids under a wrapped black-box shift).
    const interiorLines = db.getLines().flatMap((line) => {
      const s = resolveEndpointOf(line.source);
      const t = resolveEndpointOf(line.target);
      if (!s || !t) return [];
      return [
        {
          sourceOwner: s.owner,
          sourceFixed: s.isPort,
          targetOwner: t.owner,
          targetFixed: t.isPort,
          lca: commonAncestorId(s.owner, t.owner),
        },
      ];
    });
    const wrapIds = analyzeInterior(separateNodeIds, interiorLines, (nodeId) =>
      nodeId === '' ? graph : ctx.nodeById.get(nodeId),
    );
    // Mark the wrapped black-box entities and rebuild with wrapper regions inserted. The
    // engine propagates INCLUDE from each wrapper down through its uniform interior, so no
    // per-descendant marking is needed here. A POOL is never wrapped: its children ARE its
    // swimlanes, and it fits them to its own box at draw time (see drawNode) — an
    // interposed region would hide the lanes from that pass. Such a line falls back to a
    // port on each level it crosses, or a bridge.
    for (const nodeId of wrapIds) {
      const e = ctx.entityById.get(nodeId);
      if (e && e.type !== 'pool') ctx.wrap.add(e);
    }
    if (ctx.wrap.size) {
      graph = buildGraph(); // pass 2 — wrappers inserted, ctx maps rebuilt with new ids
    }
    // Translate the per-entity roles to the FINAL ids (via the rebuilt ctx.idOf). A
    // shell's normalized direction overwrites ctx.dirById; the global SEPARATE set, the
    // wrapped-black-box set, and the INCLUDE interiors (wrapper regions + flattened
    // descendants) all drive the engine below.
    ctx.dirById.clear();
    for (const [e, d] of entityDir) {
      const nodeId = ctx.idOf.get(e);
      if (nodeId) ctx.dirById.set(nodeId, d);
    }
    const separate = new Set<string>();
    for (const e of separateEntities) {
      const nodeId = ctx.idOf.get(e);
      if (nodeId) separate.add(nodeId);
    }
    const wrapped = new Set<string>();
    // The wrapper region ids re-open INCLUDE inside a black-box; the engine propagates
    // the flat/INCLUDE flow down from them, so we need only the wrapper ids themselves.
    const wrappers = new Set<string>(ctx.wrapperIds);
    for (const e of ctx.wrap) {
      const nodeId = ctx.idOf.get(e);
      if (nodeId) {
        wrapped.add(nodeId);
        // The wrapper region carries the shell's normalized direction (harmless — it is
        // INCLUDE, so its flow is imposed) so a rare wrapper-as-LCA has a direction.
        const d = entityDir.get(e);
        if (d) ctx.dirById.set(`${nodeId}.0`, d);
      }
    }
    // Whole-graph port line validation, decided up front so every connection can ask
    // about itself.
    const validation = analysePorts(entities, db.getLines());
    // Resolve each line to the agnostic RouteLine the layout engine consumes: its
    // endpoints, their LCA, and its resolved draw style. Every BPMN-specific decision
    // (endpoint resolution, pool ports, the message-flow / data-association look,
    // validity, stroke) is made HERE, so the engine below stays diagram-agnostic.
    // Unresolvable lines are dropped with a warning.
    const routeLines: RouteLine[] = [];
    db.getLines().forEach((line, i) => {
      const source = resolveEndpointOf(line.source);
      const target = resolveEndpointOf(line.target);
      if (!source || !target || source.elk === target.elk) {
        console.warn(`bpmn: could not draw connection ${describeLine(line)}`);
        return;
      }
      const lca = commonAncestorId(source.owner, target.owner);
      const connId = `conn${i}`;
      const invalid = validation.isInvalidLine(line);
      // A line touching a data element or a text annotation is a data association:
      // dotted, with an open (line-only) arrowhead. This takes priority over the
      // message-flow look. The OWNER (not the endpoint entity) is tested so a line
      // routed THROUGH a declared port still counts — a port's owner is the container
      // it sits on, so a port inside a text/data annotation resolves to it.
      const touchesAnnotation = (owner: string): boolean => {
        const t = ctx.types.get(owner);
        return t === 'data' || t === 'text';
      };
      const dataAssoc =
        !invalid && (touchesAnnotation(source.owner) || touchesAnnotation(target.owner));
      // A message flow crosses pool boundaries: its endpoints sit in different pools
      // (or one in none). Data associations are excluded above, so a data line keeps
      // the dotted look even across pools.
      const messageFlow =
        !invalid && !dataAssoc && poolOf(source.owner, ctx) !== poolOf(target.owner, ctx);
      const arrow = arrowFor(line.type);
      const style: ConnStyle = {
        arrow,
        invalid,
        // BPMN routes its annotation lines like any other line (dotted, with an open
        // head — see `dataAssoc`), so the engine's straight-line path is never taken.
        text: false,
        stroke: invalid ? undefined : lineStroke(line, lca, ctx, resolved),
        messageFlow,
        dataAssoc,
        // A leading `/` marks the source (start) end, a trailing `/` the target (end)
        // end. On a single edge (drawn source → target) these land directly; a manual
        // route redistributes them per segment (see applyManualRoute).
        slashStart: line.slash === 'start' || line.slash === 'both',
        slashEnd: line.slash === 'end' || line.slash === 'both',
      };
      // For a single edge the path runs source → target, so the origin circle sits
      // opposite the arrowhead: at the start for --> / ---, at the end for <--. A
      // manual route recomputes this per segment (see applyManualRoute).
      if (messageFlow) style.circle = arrow === 'start' ? 'end' : 'start';

      // The exit/enter sides the routing will use, from the same pure helpers planRoute
      // calls — needed here to pin a pool port on the side that faces the other endpoint.
      const lcaDir = lca === '' ? rootLayoutDir : ctx.dirById.get(lca) ?? rootLayoutDir;
      const exitSide = resolveExitSide(line.routing?.exit, source.owner, target.owner, lca, lcaDir);
      const enterSide = resolveEnterSide(line.routing?.enter, exitSide);
      const srcRef = poolPortEndpoint(source, connId, 's', exitSide);
      const tgtRef = poolPortEndpoint(target, connId, 't', enterSide);

      routeLines.push({
        id: connId,
        source: srcRef,
        target: tgtRef,
        lca,
        lineType: line.type,
        routing: line.routing ?? null,
        label: line.label,
        style,
        describe: describeLine(line),
      });
    });
    // The layout engine turns those into ELK edges / chains / bridges. It calls back
    // through a small adapter for node & direction lookup and caption writing, so it
    // never touches the BPMN model. Then we drop ordering edges a real edge replaced.
    const adapter: RouteAdapter = {
      nodeById: (nodeId) => ctx.nodeById.get(nodeId),
      dirById: (nodeId) => ctx.dirById.get(nodeId),
      applyEdgeLabel: (edge, text) => applyEdgeLabel(edge, text, ctx.measure),
    };
    const {
      styles: connStyles,
      connected,
      hierarchyContainers,
      blackBoxContainers,
      manualEdges,
      straightEdges,
      debugSeparate,
    } = addConnections(graph, routeLines, adapter, rootLayoutDir, separate, { wrapped, wrappers });
    // INCLUDE_CHILDREN lets ELK route an edge across subtree boundaries, but it forces
    // one flow direction across that node's whole subtree. The engine set both sets
    // explicitly per container — INCLUDE propagated from the root and stopping at each
    // black-box, SEPARATE on the black-boxes themselves — so the two loops are disjoint
    // by construction and their order does not matter.
    for (const container of hierarchyContainers) {
      const opts = (container.layoutOptions ??= {}) as Record<string, string>;
      opts['elk.hierarchyHandling'] = 'INCLUDE_CHILDREN';
    }
    for (const container of blackBoxContainers) {
      const opts = (container.layoutOptions ??= {}) as Record<string, string>;
      opts['elk.hierarchyHandling'] = 'SEPARATE_CHILDREN';
    }
    pruneOrderingEdges(graph, connected);
    // All measuring is done synchronously above; drop the probe before layout.
    done();

    // Index the resolved styles by the node ids the draw pass works with.
    const resolvedById = new Map<string, Resolved>();
    for (const [nodeId, entity] of ctx.entityById) {
      const r = resolved.get(entity);
      if (r) resolvedById.set(nodeId, r);
    }

    let laid = await elk.layout(graph);
    // Pools that share a flow direction are stretched to a common length so a stack of
    // them lines up flush (like a pool's lanes). This needs the laid-out lengths, so it
    // runs after the first layout and, when it pins any pool, lays out once more — ELK
    // then re-places each pool's content and re-aligns the stack.
    if (equalisePoolLengths(laid, ctx)) {
      laid = await elk.layout(graph);
    }
    // PROTOTYPE: pull wrapper-bridge auto-ports onto their counterpart's axis, then re-lay.
    if (ALIGN_BRIDGE_PORTS && manualEdges.length > 0) {
      if (alignBridgePorts(laid, manualEdges)) laid = await elk.layout(graph);
    }

    // Resolve the icons any entity referenced to inline SVG (loading lazy packs on the
    // way). Skipped entirely when the diagram uses none, so `@iconify/utils` and the
    // packs are never touched by an icon-free render.
    const iconSpecs = new Set<string>();
    for (const r of resolved.values()) if (r.icon) iconSpecs.add(r.icon);
    // Activity marker glyphs (composite `+`, loop/multi-instance) are resolved too,
    // though they live outside the per-entity `icon` slot (see markerSpecsById).
    for (const specs of ctx.markerSpecsById.values()) for (const s of specs) iconSpecs.add(s);
    const icons = iconSpecs.size > 0 ? await resolveIcons(iconSpecs) : new Map<string, IconSvg>();

    // Absolute node boxes (and port points) for the gate-edge clipping below, the
    // hand-drawn bridges, and the boundary-event circles.
    const absRects = new Map<string, AbsRect>();
    const portPoints = new Map<string, { x: number; y: number }>();
    for (const node of laid.children ?? []) collectAbsRects(node, 0, 0, absRects, portPoints);
    // Gateways are diamonds inscribed in these boxes, so edge endpoints landing on
    // their box border are pulled in to the diamond edge (see gateClipper).
    const gateBoxes: AbsRect[] = [];
    for (const [nodeId, box] of absRects) {
      if (ctx.types.get(nodeId) === 'gate') gateBoxes.push(box);
    }
    const clip = gateClipper(gateBoxes);

    // Resolve each text annotation's bracket edge now that the boxes are laid out: an
    // explicit side, else its first port, else a connected entity's direction, else west.
    const bracketSideById = resolveBracketSides(ctx, db.getLines(), laid);

    const markers: Markers = createMarkers(svg, id, {
      line: theme.line,
      background: theme.background,
    });
    const drawCtx: DrawCtx = {
      types: ctx.types,
      resolvedById,
      regionRects: new Map(),
      laneRects: new Map(),
      flowById: ctx.flowById,
      eventOpById: ctx.eventOpById,
      activityTypeById: ctx.activityTypeById,
      markerSpecsById: ctx.markerSpecsById,
      dataTypeById: ctx.dataTypeById,
      icons,
      labelWidths: ctx.labelWidths,
      topBandById: ctx.topBandById,
      debugPorts: db.getDebugPorts(),
      declaredPortIds: ctx.declaredPortIds,
      boundaryInsetById: ctx.boundaryInsetById,
      bracketSideById,
      debugBlackBoxIds: debugSeparate,
      debugWrapperIds: new Set(ctx.wrapperIds),
    };
    for (const node of regionsFirst(laid.children ?? [], ctx.types)) {
      drawNode(svg, node, 0, 0, drawCtx);
    }
    drawEdges(svg, laid, 0, 0, connStyles, markers, clip);

    // Post-layout edge drawing: the straight-by-default lines (unused by BPMN, which
    // routes its annotation lines — kept so the engine's contract stays honoured) and
    // the hand-drawn bridges for boundary crossings whose port chains stopped short of
    // the LCA.
    if (manualEdges.length > 0 || straightEdges.length > 0) {
      // Straight lines first, so any bridge (a routed line) paints over them.
      for (const edge of straightEdges) drawStraightEdge(svg, edge, absRects, markers, clip);

      const resolve = (a: Anchor): AbsRect | undefined => {
        if (a.kind === 'box') return absRects.get(a.id);
        const p = portPoints.get(a.portId);
        return p && { x: p.x, y: p.y, w: 0, h: 0 };
      };
      for (const edge of manualEdges) {
        const from = resolve(edge.from);
        const to = resolve(edge.to);
        if (from && to) {
          const points = orthogonalPoints(from, to, edge.bend, edge.exitSide, edge.enterSide);
          clip(points);
          // Under the debug overlay, tint valid manual bridges blue so they read as
          // hand-drawn among the ELK edges. Invalid lines keep their bold red.
          const style =
            drawCtx.debugPorts && !edge.style.invalid
              ? { ...edge.style, stroke: DEBUG_MANUAL_STROKE }
              : edge.style;
          drawEdgePolyline(svg, points, style, markers);
          if (edge.label) drawLineLabelNearSource(svg, points, edge.label);
        }
      }
    }

    // Boundary events last, over their host activity and any edge stub: each draws as
    // an event circle centred on the port point ELK laid out on the host's border.
    for (const [portId, be] of ctx.boundaryEvents) {
      const p = portPoints.get(portId);
      if (!p) continue;
      // The port's top-left plus its anchor is the border point; centre the circle
      // there (the port itself is larger, holding the reserved outward label room).
      const cx = p.x + be.anchor.ax;
      const cy = p.y + be.anchor.ay;
      drawBoundaryEvent(
        svg,
        { x: cx - EVENT_SIZE / 2, y: cy - EVENT_SIZE / 2, w: EVENT_SIZE, h: EVENT_SIZE },
        be,
        icons,
      );
    }

    const width = Math.max(laid.width ?? 0, LEAF_MIN_W);
    const height = Math.max(laid.height ?? 0, LEAF_H);
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));
  },
};
