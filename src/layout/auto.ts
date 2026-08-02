import { type ElkExtendedEdge, type ElkNode } from 'elkjs/lib/elk.bundled.js';
import { layoutProcess } from 'bpmn-auto-layout';
import { type Entity, type Line } from '../db.js';
import {
  type FlowRef,
  assignNodeIds,
  collectFlowNodes,
  domainToBpmnXml,
} from '../domain-to-xml.js';
import { applyLayoutCoordinates, bpmnXmlToDomain, type LayoutedDomain } from '../xml-to-domain.js';
import { EVENT_SIZE, GATE_SIZE } from '../bpmnStyle.js';

export const AUTO_PADDING = 20;
/** Clearance a grouping box keeps around the members it surrounds. */
const GROUP_PADDING = 14;
/** Extra height a grouping box reserves at the top for its own caption. */
const GROUP_LABEL_BAND = 18;
const FALLBACK_W = 120;
const FALLBACK_H = 66;
const FALLBACK_COL = 150;
const FALLBACK_ROW = 100;
const FALLBACK_COLS = 5;

export interface AutoLayoutResult {
  /** Positioned tree, in the shape the SVG drawing code expects. */
  root: ElkNode;
  /** Node id -> the entity it was drawn for. Node ids are the BPMN element ids. */
  nodeIds: Map<string, Entity>;
  /** Edge id -> the line it was drawn for, plus its endpoints. */
  flowIds: Map<string, FlowRef>;
  /**
   * The BPMN 2.0 document the drawing was made from, with the diagram
   * interchange the layouter produced. Absent when the layout could not be run
   * at all and the grid fallback was used instead.
   */
  xml?: string;
}

/**
 * Auto-layout via the bpmn-auto-layout library. ELK is not involved at all:
 * the coordinates and waypoints it returns are the final word.
 *
 * 1. serialise the domain model to BPMN XML
 * 2. let bpmn-auto-layout position everything
 * 3. read the bounds and waypoints back out of the returned XML
 * 4. build the positioned tree the renderer draws from
 */
export async function autoLayout(entities: Entity[], lines: Line[]): Promise<AutoLayoutResult> {
  const run = async (options?: { omitArtifacts: boolean }) => {
    const serialized = await domainToBpmnXml(entities, lines, options);
    const result = await layoutProcess(serialized.xml);
    const layoutedXml = typeof result === 'string' ? result : result.xml;
    if (!layoutedXml) throw new Error('bpmn-auto-layout returned no XML');
    if (typeof result !== 'string') {
      for (const warning of (result.warnings ?? []) as { message?: string }[]) {
        console.warn('bpmn: auto-layout:', warning.message ?? warning);
      }
    }

    const layout = await bpmnXmlToDomain(layoutedXml);
    if (layout.entityBounds.size === 0 && serialized.nodeIds.size > 0) {
      throw new Error('bpmn-auto-layout returned no shape bounds');
    }
    return { serialized, layout, layoutedXml };
  };

  let attempt: Awaited<ReturnType<typeof run>>;
  try {
    attempt = await run();
  } catch (error) {
    // The layouter rejects a whole document over a single artifact it cannot
    // find room for, so the flow is laid out on its own before giving up on it.
    const message = error instanceof Error ? error.message : String(error);
    console.warn('bpmn: auto-layout retrying without artifacts:', message);
    try {
      attempt = await run({ omitArtifacts: true });
    } catch (retryError) {
      console.warn('bpmn: auto-layout failed, falling back to a grid:', retryError);
      return fallbackLayout(entities, lines);
    }
  }

  const { serialized, layout, layoutedXml } = attempt;
  const { nodeIds, flowIds, parentOf } = serialized;
  applyLayoutCoordinates(nodeIds, flowIds, layout);
  return {
    root: buildRenderTree(nodeIds, flowIds, layout, parentOf),
    nodeIds,
    flowIds,
    xml: layoutedXml,
  };
}

/**
 * Turn the flat, absolutely positioned output into the tree the renderer draws.
 *
 * bpmn-auto-layout returns one plane holding every shape, whatever it is nested
 * in; the drawing code walks a tree with parent-relative coordinates (that is
 * what makes a node a container), so the nesting is restored here.
 *
 * A grouping box the layouter left unplaced — it drops one whose members it
 * could not resolve — is derived from the members the DSL declared inside it,
 * once those have been placed.
 */
function buildRenderTree(
  nodeIds: Map<string, Entity>,
  flowIds: Map<string, FlowRef>,
  layout: LayoutedDomain,
  parentOf: Map<string, string>,
): ElkNode {
  const root: ElkNode = {
    id: 'root',
    layoutOptions: {},
    children: [],
    edges: [],
  };

  const childrenOf = new Map<string, string[]>();
  for (const [id, parentId] of parentOf) {
    const list = childrenOf.get(parentId);
    if (list) list.push(id);
    else childrenOf.set(parentId, [id]);
  }

  const isGroup = (id: string): boolean => {
    const type = nodeIds.get(id)?.type;
    return type === 'group' || type === 'region';
  };

  // Absolute box of every drawn node. The layouter's own output comes first, so
  // a group can be sized from members that are all already placed.
  const absolute = new Map<string, Box>();
  for (const id of nodeIds.keys()) {
    const bounds = layout.entityBounds.get(id);
    if (bounds)
      absolute.set(id, {
        x: bounds.x,
        y: bounds.y,
        w: bounds.width,
        h: bounds.height,
      });
  }

  // Nothing should reach this point without a box, but a node the layouter
  // silently skipped — or one deliberately left out of the document, see the
  // artifact retry — is parked in a row underneath rather than dropped from the
  // drawing without a trace. It is parked at the top level, because a box laid
  // out on its own is not going to fit inside whatever declared it.
  const unplaced = [...nodeIds.keys()].filter((id) => !absolute.has(id) && !isGroup(id));
  if (unplaced.length > 0) {
    const bottom = Math.max(
      0,
      ...[...absolute.values()].map((b) => b.y + b.h),
      ...[...layout.lineWaypoints.values()].flat().map((p) => p.y),
    );
    for (const id of unplaced) parentOf.delete(id);
    unplaced.forEach((id, index) => {
      absolute.set(id, {
        x: AUTO_PADDING + index * FALLBACK_COL,
        y: bottom + AUTO_PADDING,
        w: FALLBACK_W,
        h: FALLBACK_H,
      });
    });
  }

  // A grouping box spans its members, plus room for its own caption. A nested
  // group is resolved first, so the outer one sees the inner one's box.
  const measure = (id: string): Box | undefined => {
    const cached = absolute.get(id);
    if (cached) return cached;

    const members = (childrenOf.get(id) ?? [])
      .map(measure)
      .filter((box): box is Box => box !== undefined);
    if (members.length === 0) return undefined;

    const x = Math.min(...members.map((b) => b.x)) - GROUP_PADDING;
    const y = Math.min(...members.map((b) => b.y)) - GROUP_PADDING - GROUP_LABEL_BAND;
    const box = {
      x,
      y,
      w: Math.max(...members.map((b) => b.x + b.w)) + GROUP_PADDING - x,
      h: Math.max(...members.map((b) => b.y + b.h)) + GROUP_PADDING - y,
    };
    absolute.set(id, box);
    return box;
  };
  for (const id of nodeIds.keys()) if (isGroup(id)) measure(id);

  // A group's box reaches outside the members it surrounds, so it can run off
  // the top-left corner the layouter left clear. Everything moves together.
  let shiftX = 0;
  let shiftY = 0;
  for (const box of absolute.values()) {
    shiftX = Math.max(shiftX, AUTO_PADDING - box.x);
    shiftY = Math.max(shiftY, AUTO_PADDING - box.y);
  }
  if (shiftX || shiftY) {
    for (const box of absolute.values()) {
      box.x += shiftX;
      box.y += shiftY;
    }
  }

  const byId = new Map<string, ElkNode>();
  for (const id of nodeIds.keys()) {
    const box = absolute.get(id);
    if (box) byId.set(id, { id, x: box.x, y: box.y, width: box.w, height: box.h });
  }

  for (const [id, node] of byId) {
    const parentId = parentOf.get(id);
    const parent = parentId ? byId.get(parentId) : undefined;
    if (!parent) {
      root.children!.push(node);
      continue;
    }
    // The absolute boxes are the source of truth on both sides, so the shift is
    // taken from them rather than from the parent node, which may already have
    // been made relative to a grandparent.
    const parentBox = absolute.get(parentId!)!;
    node.x = (node.x ?? 0) - parentBox.x;
    node.y = (node.y ?? 0) - parentBox.y;
    (parent.children ??= []).push(node);
  }

  // A grouping box is drawn before the shapes it surrounds, so its border never
  // paints over a member. Sorting is stable, so everything else keeps its order.
  const groupsFirst = (siblings: ElkNode[]): void => {
    siblings.sort((a, b) => Number(isGroup(b.id)) - Number(isGroup(a.id)));
    for (const node of siblings) if (node.children) groupsFirst(node.children);
  };
  groupsFirst(root.children!);

  // Every edge stays on the root in absolute coordinates: the waypoints come out
  // of the layouter that way, and the root's own origin is (0, 0).
  for (const [id, flow] of flowIds) {
    const raw = layout.lineWaypoints.get(id);
    // A line touching a group never reached BPMN, so the layouter routed nothing
    // for it. Both boxes are known by now, so it is drawn straight between them.
    const waypoints =
      raw && raw.length >= 2
        ? raw.map((p) => ({ x: p.x + shiftX, y: p.y + shiftY }))
        : straightBetween(absolute.get(flow.sourceId), absolute.get(flow.targetId));
    if (!waypoints) continue;

    const bendPoints = waypoints.slice(1, -1);
    const edge: ElkExtendedEdge = {
      id,
      sources: [flow.sourceId],
      targets: [flow.targetId],
      sections: [
        {
          id: `${id}_s0`,
          startPoint: waypoints[0],
          endPoint: waypoints[waypoints.length - 1],
          ...(bendPoints.length > 0 ? { bendPoints } : {}),
        },
      ],
    };
    root.edges!.push(edge);
  }

  sizeRoot(root);
  return root;
}

/** The centre-to-centre segment between two boxes, clipped to their borders. */
function straightBetween(
  source: Box | undefined,
  target: Box | undefined,
): { x: number; y: number }[] | undefined {
  if (!source || !target) return undefined;
  const from = { x: source.x + source.w / 2, y: source.y + source.h / 2 };
  const to = { x: target.x + target.w / 2, y: target.y + target.h / 2 };
  if (from.x === to.x && from.y === to.y) return undefined;
  return [borderPoint(source, to), borderPoint(target, from)];
}

/** Where the ray from a box's centre towards `toward` leaves the box. */
function borderPoint(box: Box, toward: { x: number; y: number }): { x: number; y: number } {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const dx = toward.x - cx;
  const dy = toward.y - cy;
  const scale = Math.min(
    dx === 0 ? Infinity : box.w / 2 / Math.abs(dx),
    dy === 0 ? Infinity : box.h / 2 / Math.abs(dy),
  );
  // Both deltas are zero only when the centres coincide, which the caller rules out.
  return { x: cx + dx * scale, y: cy + dy * scale };
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Last resort when bpmn-auto-layout cannot process the diagram: a plain grid,
 * so the shapes are at least visible and non-overlapping.
 */
function fallbackLayout(entities: Entity[], lines: Line[]): AutoLayoutResult {
  const nodeIds = assignNodeIds(collectFlowNodes(entities).nodes);
  const root: ElkNode = {
    id: 'root',
    layoutOptions: {},
    children: [],
    edges: [],
  };

  let index = 0;
  for (const [id, entity] of nodeIds) {
    // A gateway is a diamond and an event a circle, so both have to stay square
    // or the shape is drawn skewed.
    const square = entity.type === 'gate' ? GATE_SIZE : entity.type === 'event' ? EVENT_SIZE : 0;
    root.children!.push({
      id,
      x: AUTO_PADDING + (index % FALLBACK_COLS) * FALLBACK_COL,
      y: AUTO_PADDING + Math.floor(index / FALLBACK_COLS) * FALLBACK_ROW,
      width: square || FALLBACK_W,
      height: square || FALLBACK_H,
    });
    index++;
  }

  sizeRoot(root);
  // No geometry is known for the lines, so they are simply not drawn.
  return { root, nodeIds, flowIds: new Map<string, FlowRef>() };
}

function sizeRoot(root: ElkNode): void {
  let maxX = 0;
  let maxY = 0;
  // Coordinates below the root are parent-relative, so the offset is threaded
  // down; a nested node can stick out of its parent (a boundary event does).
  const walk = (node: ElkNode, ox: number, oy: number): void => {
    const x = ox + (node.x ?? 0);
    const y = oy + (node.y ?? 0);
    maxX = Math.max(maxX, x + (node.width ?? 0));
    maxY = Math.max(maxY, y + (node.height ?? 0));
    for (const child of node.children ?? []) walk(child, x, y);
  };
  for (const child of root.children ?? []) walk(child, 0, 0);

  for (const edge of root.edges ?? []) {
    for (const section of edge.sections ?? []) {
      const points = [section.startPoint, section.endPoint, ...(section.bendPoints ?? [])];
      for (const p of points) {
        if (!p) continue;
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      }
    }
  }
  root.x = 0;
  root.y = 0;
  root.width = maxX + AUTO_PADDING;
  root.height = maxY + AUTO_PADDING;
}
