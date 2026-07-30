// The BPMN diagram style: how each BPMN entity family is sized (build) and drawn
// (draw), plus per-line style resolution. Everything diagram-SPECIFIC lives here;
// the layout engine (layout/*, render.ts) works only against the agnostic shapes.
// Replace this file to build a different diagram style on the same engine.
import type { ElkNode } from 'elkjs/lib/elk.bundled.js';
import {
  ACTIVITY_CONTAINER_TYPES,
  type ActivityType,
  BOUNDARY_OPERATIONS,
  type DataType,
  type Direction,
  type Entity,
  type EntityType,
  type EventOperation,
  type Line,
  type Side,
  entityLabel,
} from './db.js';
import { type Rect, partitionRegions, regionsStackVertically } from './geometry.js';
import type { Resolved } from './styleModel.js';
import type { IconSvg } from './icons.js';
import type { AbsRect, Pt } from './layout/geometry.js';
import { svgEl } from './layout/svg.js';
import {
  type Measure,
  captionHeight,
  captionLines,
  captionText,
  measureCaption,
} from './layout/text.js';
import { LINE_LABEL_CLASS, type LabelableEdge, collectAbsRects } from './layout/edges.js';
import { ELK_DIRECTION, ELK_PORT_SIDE, chainEdges, padding } from './layout/elk.js';

// The entity families this style draws. Any family NOT listed here is skipped
// entirely — dropped from the ELK graph together with its subtree — and lines to a
// skipped entity resolve to nothing and are warned+dropped like any other unknown
// endpoint. `region` and `port` are structural (a transparent grouping box and an
// edge anchor) and always kept.
export const SUPPORTED_TYPES: ReadonlySet<EntityType> = new Set<EntityType>([
  'pool',
  'lane',
  'activity',
  'gate',
  'event',
  'data',
  'region',
  'group',
  'text',
  'port',
  // A diagnostic node the parser inserts for an unparseable line or an unresolved
  // line endpoint; drawn as a plain box with an extra-bold red border.
  'error',
]);

// Layout tuning. Leaf boxes size to their label; containers reserve a band at
// the top for their own label above their children.
export const LEAF_MIN_W = 80;
export const LEAF_H = 44;
// An activity's minimum box is 50% larger than the generic leaf minimum, so tasks
// read as the primary shape; every other family (pools, gateways, events) keeps
// the base size.
export const ACTIVITY_MIN_W = LEAF_MIN_W * 1.5; // 120
export const ACTIVITY_MIN_H = LEAF_H * 1.5; // 66
export const LABEL_PAD_X = 20; // horizontal breathing room around a leaf label
export const CONTAINER_LABEL_BAND = 30; // top padding reserved for a container's label
export const CONTAINER_PAD = 12; // left/right/bottom padding inside a container
export const GROUP_CORNER = 10; // corner radius of a group's round-cornered box
export const NODE_SPACING = 24; // gap between sibling boxes

// An activity is drawn as a slightly rounded rectangle (the BPMN task shape). Its
// activity type refines that outline: a `call` activity gets a bold (double width)
// border; an `event-subprocess` a dotted one; a `transaction` a double outline drawn
// with thinner lines (an inner rounded rect inset from the outer). `task` and
// `subprocess` keep the plain single outline.
export const ACTIVITY_RADIUS = 6;
export const ACTIVITY_STROKE = 1.5; // the default entity stroke width (see styles.ts)
export const ACTIVITY_THICK = ACTIVITY_STROKE * 2; // a call activity's bold border
export const ACTIVITY_DOTTED = '1.5 3'; // an event-subprocess's dotted outline
export const ACTIVITY_DOUBLE_GAP = 4; // a transaction's inner-outline inset
export const ACTIVITY_DOUBLE_STROKE = 1; // a transaction's thinner double lines

// BPMN activity markers sit in a row centred along the box's bottom edge: the
// collapsed-composite `+`, and the loop / multi-instance marker. A box that
// carries any reserves a MARKER_BAND-tall strip at its bottom so the marker row
// does not collide with the centred caption above it.
export const MARKER_SIZE = 16; // one marker glyph
export const MARKER_GAP = 3; // spacing between markers in the row
export const MARKER_BAND = MARKER_SIZE + 6; // bottom strip reserved for the marker row

// An empty pool (no lanes) is a fixed sharp-cornered box: eight activity widths
// across, two activity heights tall, with its label centred.
export const POOL_MIN_W = LEAF_MIN_W * 8;
export const POOL_MIN_H = LEAF_H * 2;

// A gateway is a diamond (a square rotated 45°) with a type marker drawn inside.
// GATE_SIZE is its bounding box; GATE_ICON the marker's size, kept small enough to
// sit inside the diamond's inscribed square.
export const GATE_SIZE = 48;
export const GATE_ICON = 24;

// An event is a circle with a type marker inside. Its outline style (thin/thick/
// double/dashed) comes from the event operation; the marker from the event type.
export const EVENT_SIZE = 44;
export const EVENT_ICON = 26; // the marker fills most of the circle (~22px of glyph)
export const EVENT_DOUBLE_GAP = 3; // ring spacing for intermediate/boundary (double) events
export const EVENT_THICK = 4.5; // stroke width for an end event's bold ring
export const EVENT_DASH = '4.5 3'; // dash/gap for a non-interrupting (dashed) ring

// A data element is a fixed box, taller than wide (4:5), with its caption centred
// inside. A data OBJECT is a rectangle with its top-right corner folded (a
// dog-ear); a data STORE is a cylinder with a lid. DATA_FOLD is the dog-ear's leg
// length; DATA_LID_RY the half-height of the cylinder's top/bottom ellipses.
export const DATA_W = 72;
export const DATA_H = 90; // 4:5, taller than wide
export const DATA_FOLD = 21;
export const DATA_LID_RY = 10.5;
// The `collection` marker: three vertical bars centred along the data object's
// bottom edge. GAP is the clearance from the bottom, BAR_GAP the spacing between
// bars (also their offset from centre for the outer two).
export const DATA_COLLECTION_BAR_H = 16;
export const DATA_COLLECTION_GAP = 6;
export const DATA_COLLECTION_BAR_GAP = 6;

// A caption may span several lines (a `\n` escape, or a `|` multi-line label). Each
// line is drawn on its own row and reserved this much vertical room; a box grows
// taller for extra lines so a multi-line caption is never clipped. This is the
// style's own line height — every call into layout/text passes it explicitly rather
// than taking that module's generic default.
export const LABEL_LINE_H = 16;

// Gateways and events draw their caption OUTSIDE the shape — below it in a
// horizontal flow, to its right in a vertical one — reserved as an ELK OUTSIDE
// node label.
export const OUTSIDE_LABEL_LINE_H = LABEL_LINE_H; // reserved height per outside caption line
export const OUTSIDE_LABEL_GAP = 6; // spacing between the shape and its outside caption

// A text annotation is a transparent box with an open, bold bracket drawn on ONE
// edge — the BPMN text-annotation cue. The bracket runs the full edge with a short
// cap turning in at each end; `TEXT_BRACKET_CAP` is that cap's length (clamped to a
// third of the box so the caps never meet), `TEXT_BRACKET_STROKE` its bold width.
export const TEXT_BRACKET_CAP = 12;
export const TEXT_BRACKET_STROKE = 2;

// Under the `debug ports` overlay, every hand-drawn bridge (the manual, non-ELK
// segments) is tinted blue so it stands out from the ELK-routed lines — alongside
// the red/green port squares the same overlay draws.
export const DEBUG_MANUAL_STROKE = '#2962ff';
// Also under `debug ports`: a black-boxed (SEPARATE_CHILDREN) container gets an
// orange dash-dash-dot-dot overlay outline so it reads as "laid out on its own", and
// each synthetic interior wrapper region is filled translucent magenta so the
// inserted INCLUDE region is visible. See docs/routing.md.
export const DEBUG_BLACKBOX_STROKE = '#ff6d00';
export const DEBUG_BLACKBOX_DASH = '7 3 7 3 1 3 1 3';
export const DEBUG_WRAPPER_FILL = '#ff00ff';
export const DEBUG_WRAPPER_OPACITY = 0.3;

// Icons (see icons.ts). An inline icon is drawn at one line height, before the
// label; a box with neither label nor children draws its icon alone at twice that
// (an icon-only glyph). `ICON_GAP` sits between an inline icon and its label.
export const ICON_SIZE = 18; // one line height — the inline icon size
export const ICON_SIZE_LARGE = ICON_SIZE * 2; // the label-less, childless box's big icon
export const ICON_GAP = 6;

// The side a boundary event pins to under `auto` (the default): 90° clockwise from
// the host activity's layout direction. With LR flow the event drops to the SOUTH
// edge (the BPMN convention), TB flow sends it WEST, and so on for the reverse
// directions. An explicit compass side overrides this.
export const ROTATE_CW_90: Record<Direction, Side> = { LR: 's', TB: 'w', RL: 'n', BT: 'e' };

// Toggles a direction to its perpendicular axis while PRESERVING the sign:
// TB↔LR and BT↔RL. A pool — and the diagram root when it holds pools — stacks its
// children ACROSS the flow, so its ELK layout direction is the toggled flow: a
// horizontal (LR) pool stacks its lanes top-to-bottom (TB); a reversed vertical
// (BT) pool stacks them right-to-left (RL); and so on. This is purely a layout
// concern — the children still inherit the un-toggled flow.
export const TOGGLE_AXIS: Record<Direction, Direction> = { TB: 'LR', LR: 'TB', BT: 'RL', RL: 'BT' };

// The edge a pool/lane label band sits on — the start of the flow: LR→west,
// RL→east, TB→north, BT→south.
export const BAND_SIDE: Record<Direction, Side> = { LR: 'w', RL: 'e', TB: 'n', BT: 's' };

// The label rotation (SVG degrees, clockwise) inside that band. A west band reads
// bottom-to-top (−90); an east band top-to-bottom (90); a top/bottom band stays
// horizontal.
export const LABEL_ROT: Record<Direction, number> = { LR: -90, RL: 90, TB: 0, BT: 180 };

// The thickness of a pool/lane label band (its short dimension). The label runs
// along the band's long axis.
export const POOL_LABEL_BAND = CONTAINER_LABEL_BAND;

// A port never draws a caption; everything else (activity, region heading) draws
// its caption INSIDE the box — centred in a leaf, or in the top label band of a
// container. Whether a caption exists at all is decided per entity by
// `entityLabel`; this only says whether a present caption is drawn here.
export function drawsInternalLabel(type: EntityType): boolean {
  return type !== 'port';
}

// Every drawn family may carry an `icon:` — i.e. everything but `port`, which
// draws nothing at all.
export function canHaveIcon(type: EntityType): boolean {
  return type !== 'port';
}

// The bpmn-pack icon specs for the markers drawn in an activity's bottom row, in
// draw order. A loop or multi-instance activity gets its loop/bar marker first; a
// `collapsed` expandable activity (a subprocess/call-subprocess/event-subprocess/
// transaction drawn without its children) gets the composite `+` LAST. These are
// independent of the task-type glyph (which is drawn with the caption). The
// `compensation` marker reuses the bpmn `compensation-in` glyph.
export function activityMarkerSpecs(entity: Entity, collapsed: boolean): string[] {
  const specs: string[] = [];
  if (entity.marker === 'loop') specs.push('bpmn:loop');
  else if (entity.marker === 'sequential') specs.push('bpmn:mi-sequential');
  else if (entity.marker === 'parallel') specs.push('bpmn:mi-parallel');
  else if (entity.marker === 'compensation') specs.push('bpmn:compensation-in');
  else if (entity.marker === 'adhoc') specs.push('bpmn:adhoc');
  if (collapsed && entity.activityType && ACTIVITY_CONTAINER_TYPES.has(entity.activityType)) {
    specs.push('bpmn:composite');
  }
  return specs;
}

// Turns an `icon-size` factor (of the line height, see StyleProps.iconSize) into a
// pixel size. A falsy factor (0/undefined = auto) falls back to `auto`, the size
// the context would use on its own; a positive factor scales the line height.
export function iconPx(factor: number | undefined, auto: number): number {
  return factor && factor > 0 ? factor * ICON_SIZE : auto;
}

// The ELK options a container node carries. Like the agnostic `containerOptions`,
// but with the two things BPMN containers need on top: a separate BOTTOM pad (an
// expanded activity reserves a marker band there) and per-side boundary-event
// clearance folded into the padding.
export function containerOptions(
  direction: Direction,
  topPad: number,
  sidePad: number,
  bottomPad: number = sidePad,
  inset: BoundaryInset = NO_INSET,
): Record<string, string> {
  return {
    'elk.algorithm': 'layered',
    'elk.direction': ELK_DIRECTION[direction],
    'elk.spacing.nodeNode': String(NODE_SPACING),
    'elk.layered.spacing.nodeNodeBetweenLayers': String(NODE_SPACING),
    // Boundary-event sides get extra padding so the circle's inner half sits in the
    // padding, clear of the children.
    'elk.padding': padding(
      topPad + inset.n,
      sidePad + inset.w,
      bottomPad + inset.s,
      sidePad + inset.e,
    ),
    // this doesnt seem to hurt, but in some cases it makes lines more stable
    'org.eclipse.elk.layered.unnecessaryBendpoints': 'true',
  };
}

// Layout options for a pool or lane: `elkDir` is how ELK stacks the children
// (perpendicular to the flow for a pool, along it for a lane); `flow` fixes which
// edge reserves the label band; `innerPad` is the padding on the other three
// sides, and `spacing` the gap between children (0 for a pool's flush lanes).
export function poolLaneOptions(
  elkDir: Direction,
  flow: Direction,
  band: number,
  innerPad: number,
  spacing: number,
): Record<string, string> {
  const side = BAND_SIDE[flow];
  const top = side === 'n' ? band : innerPad;
  const bottom = side === 's' ? band : innerPad;
  const left = side === 'w' ? band : innerPad;
  const right = side === 'e' ? band : innerPad;
  return {
    'elk.algorithm': 'layered',
    'elk.direction': ELK_DIRECTION[elkDir],
    'elk.spacing.nodeNode': String(spacing),
    'elk.layered.spacing.nodeNodeBetweenLayers': String(spacing),
    'elk.padding': padding(top, left, bottom, right),
  };
}

// Build-time indexes threaded through the recursive node build. Beyond sizing
// each node they record the maps the connection pass needs: entity -> node id
// (and its inverse for the draw pass), a first-wins name lookup for resolving
// absolute-line endpoints, and per-container direction.
export interface BuildCtx {
  measure: Measure;
  types: Map<string, EntityType>;
  // Pre-resolved styling per entity (fills, strokes, and the per-node `icon`), so
  // the build pass can size a box to reserve room for its icon.
  resolved: Map<Entity, Resolved>;
  // Rendered caption width per node id, recorded while measuring, so the draw pass
  // can lay out an icon-plus-label group centred without re-measuring.
  labelWidths: Map<string, number>;
  // The top band each container reserves for its heading (caption/icon), by node
  // id — normally CONTAINER_LABEL_BAND, but grown for a large `icon-size`. The draw
  // pass reads it back to centre the heading and keep region fills below it.
  topBandById: Map<string, number>;
  idOf: Map<Entity, string>;
  nodeById: Map<string, ElkNode>;
  entityById: Map<string, Entity>;
  byName: Map<string, Entity>;
  // Effective flow direction each container lays its children out along, by node
  // id — the ELK layout direction, which for a pool is the TOGGLED flow (it stacks
  // its lanes across the flow). Overwritten by the direction-normalization pre-pass
  // (normalizeDirections) before routing.
  dirById: Map<string, Direction>;
  // The direction each container is PINNED to, by node id — set only where the
  // direction is the entity's own rather than inherited, so the normalization
  // pre-pass can tell a real direction change from a passed-down one. A pool/lane
  // always pins (its axis is intrinsic: a pool stacks lanes across its flow, a lane
  // runs along it), so a swimlane is never rotated by a flatten.
  explicitDirById: Map<string, Direction>;
  // The FLOW direction of each pool/lane, by node id — which may differ from the
  // ELK layout direction above. The draw pass reads it to place and rotate the
  // label band, and to fit the lanes into their pool.
  flowById: Map<string, Direction>;
  // Each event's operation, by node id — the draw pass reads it to pick the circle
  // outline (thin start, thick end, double intermediate/boundary, dashed non-interrupt).
  eventOpById: Map<string, EventOperation>;
  // Each activity's type, by node id — the draw pass reads it to pick the box
  // outline (bold for call, dotted for event-subprocess, thin double for transaction).
  activityTypeById: Map<string, ActivityType>;
  // The bpmn icon specs for each activity's bottom marker row (composite `+`,
  // loop/multi-instance), by node id. Only set when the activity has any. The draw
  // pass renders them; the icon-resolution pass also reads it to load the glyphs.
  markerSpecsById: Map<string, string[]>;
  // Each data element's type, by node id — the draw pass reads it to pick the shape
  // (folded-corner rectangle for an object, lidded cylinder for a store).
  dataTypeById: Map<string, DataType>;
  // Declared `port` entities (and boundary events, which are also border ports),
  // resolved to the ELK port they became: its id, the container node it hangs off,
  // and the edge it pins to. A line whose endpoint is a port connects to `portId`
  // (the edge lives in the LCA of the two containers).
  ports: Map<Entity, { portId: string; containerId: string; side: Side }>;
  // Every declared port's id, so the debug overlay can tint them apart from the
  // (red) routing ports.
  declaredPortIds: Set<string>;
  // Boundary events attached to an activity, by the ELK port id they became. The
  // draw pass reads this to draw the event circle (its glyph, its dashed/double
  // ring) centred on the host's border at the port's laid-out position, and to
  // place its caption on the outward side.
  boundaryEvents: Map<string, BoundaryEvent>;
  // The smart side chosen for each `auto`/omitted boundary event (facing its
  // exception target's branch); absent when no clear side was found, in which case
  // the 90°-cw default applies. See boundarySides.ts.
  boundaryAutoSide: Map<Entity, Side>;
  // Every entity referenced by at least one line, so a boundary event can tell
  // whether it has a line (and thus must move its caption clear of it).
  lineEntities: Set<Entity>;
  // Per host node id, the interior clearance reserved on each side carrying a
  // boundary event (see BoundaryInset). Read when sizing/padding the host and when
  // placing its caption and markers, so nothing lands under a boundary circle.
  boundaryInsetById: Map<string, BoundaryInset>;
  // Black-box entities whose box children toElkNode wraps in a synthetic,
  // layout-neutral INCLUDE region — so the entity stays SEPARATE (a black box) while
  // its interior is flattened, letting a deeply nested line exit with one port on a
  // direct child (an intermediate INCLUDE node) plus a bridge over the wrapper.
  // Populated by a pre-pass (analyzeInterior) only when that pays off, then the tree
  // is rebuilt; empty on the first build. See docs/routing.md.
  wrap: Set<Entity>;
  // Node ids of the synthetic wrapper regions toElkNode inserts for `wrap` entities —
  // recorded so the engine can mark them INCLUDE and the debug overlay can tint them
  // (they are otherwise indistinguishable from author-declared regions). Rebuilt.
  wrapperIds: Set<string>;
}

// One boundary event, as the build pass resolved it for the draw pass.
export interface BoundaryEvent {
  op: EventOperation | undefined;
  resolved: Resolved | undefined;
  caption: string;
  // The border point in the port's local coords (see elk.port.anchor): the circle
  // is drawn centred here, over the reserved label room.
  anchor: { ax: number; ay: number };
  // The caption box relative to the circle centre; null when uncaptioned. The draw
  // pass positions the text from it (see boundaryLabelBox).
  labelBox: LabelBox | null;
}

// One ELK port, pinned to a side. Zero-size for a declared `port`; EVENT_SIZE-ish
// for a boundary event, which reserves room for its circle and caption.
export interface ElkPortSpec {
  id: string;
  width: number;
  height: number;
  layoutOptions: Record<string, string>;
}

// Whether a child is a boundary event ATTACHED to its host activity — i.e. an
// event whose operation is a boundary op, sitting directly inside an activity.
// Such an event becomes a border port on the activity rather than a child box; a
// boundary-op event anywhere else (e.g. loose in a lane) is drawn as a normal
// event, so the parent's family is part of the test.
export function isBoundaryPortChild(parent: Entity, child: Entity): boolean {
  return (
    parent.type === 'activity' &&
    child.type === 'event' &&
    child.eventOperation !== undefined &&
    BOUNDARY_OPERATIONS.has(child.eventOperation)
  );
}

// The caption's box, as offsets from the circle centre (x right-positive, y
// down-positive). It is the single source of truth for BOTH the port's reserved
// room and where the draw pass writes the text, so the two never disagree.
//
// A boundary event's exception line always leaves the circle on the OUTWARD side
// (the port is fixed there). So a captioned event with a line places its caption
// DIAGONALLY — outward (clearing the host, which sits on the inward side) and
// shifted sideways (clearing the line, which runs straight out) — while one with no
// line keeps the caption centred on the outward side, the usual BPMN position.
export interface LabelBox {
  left: number;
  right: number;
  top: number;
  bottom: number;
}
export function boundaryLabelBox(
  beSide: Side,
  hasLine: boolean,
  labelW: number,
  labelH: number = OUTSIDE_LABEL_LINE_H,
): LabelBox {
  const r = EVENT_SIZE / 2;
  const g = OUTSIDE_LABEL_GAP;
  const lh = labelH;
  if (!hasLine) {
    // Centred just outside the circle on the outward side.
    switch (beSide) {
      case 's':
        return { left: -labelW / 2, right: labelW / 2, top: r + g, bottom: r + g + lh };
      case 'n':
        return { left: -labelW / 2, right: labelW / 2, top: -(r + g + lh), bottom: -(r + g) };
      case 'e':
        return { left: r + g, right: r + g + labelW, top: -lh / 2, bottom: lh / 2 };
      case 'w':
        return { left: -(r + g + labelW), right: -(r + g), top: -lh / 2, bottom: lh / 2 };
    }
  }
  // Diagonal: outward AND shifted sideways past the line. A top/bottom event shifts
  // east (label starts just right of the descending line); a left/right one shifts
  // south (label starts just below the outgoing line).
  switch (beSide) {
    case 's':
      return { left: g, right: g + labelW, top: r + g, bottom: r + g + lh };
    case 'n':
      return { left: g, right: g + labelW, top: -(r + g + lh), bottom: -(r + g) };
    case 'e':
      return { left: r + g, right: r + g + labelW, top: g, bottom: g + lh };
    case 'w':
      return { left: -(r + g + labelW), right: -(r + g), top: g, bottom: g + lh };
  }
}

// The port's reserved footprint (extents from the circle centre to each port edge)
// for a boundary event: the circle's half-radius all round, grown to enclose the
// caption box where there is one. The inward side (toward the host) is pinned to the
// circle half — the caption never sits inside the host — which lets a fixed
// borderOffset of -half put the circle on the border for every side.
export function boundaryPortExtents(
  beSide: Side,
  labelBox: LabelBox | null,
): { up: number; down: number; left: number; right: number } {
  const r = EVENT_SIZE / 2;
  const e = { up: r, down: r, left: r, right: r };
  if (labelBox) {
    e.right = Math.max(r, labelBox.right);
    e.left = Math.max(r, -labelBox.left);
    e.down = Math.max(r, labelBox.bottom);
    e.up = Math.max(r, -labelBox.top);
  }
  const inwardKey = { s: 'up', n: 'down', e: 'left', w: 'right' }[beSide] as
    | 'up'
    | 'down'
    | 'left'
    | 'right';
  e[inwardKey] = r;
  return e;
}

// Extra interior clearance a host reserves on each side that carries a boundary
// event, so the circle's inner half (which straddles the border into the interior)
// does not land on the host's caption, markers, or child boxes. Per side it is the
// circle's half-radius; zero where there is no event.
export interface BoundaryInset {
  n: number;
  e: number;
  s: number;
  w: number;
}
export const NO_INSET: BoundaryInset = { n: 0, e: 0, s: 0, w: 0 };

// Builds the ELK border ports for an entity's port-like children — zero-size
// anchors for declared `port`s, and EVENT_SIZE anchors straddling the border for
// boundary events attached to an activity. Both are pinned (FIXED_SIDE, see
// attachPorts) and registered in ctx so lines can resolve to them. Shared by the
// leaf and container branches of toElkNode, so an entity whose ONLY children are
// such ports still gets them — and is built as a leaf box rather than an empty
// compound node (which ELK collapses to zero size). The declaration index is kept
// in the port id so ordering stays stable across mixed port/box children. `flow`
// is the host's layout direction, used to resolve a boundary event's `auto` side.
export function declaredPorts(
  entity: Entity,
  id: string,
  ctx: BuildCtx,
  flow: Direction,
): ElkPortSpec[] {
  const ports: ElkPortSpec[] = [];
  const inset: BoundaryInset = { n: 0, e: 0, s: 0, w: 0 };
  entity.children.forEach((child, i) => {
    const portId = `${id}.port${i}`;
    if (child.type === 'port') {
      const side = child.portSide ?? 'n';
      ports.push({
        id: portId,
        width: 0,
        height: 0,
        layoutOptions: { 'elk.port.side': ELK_PORT_SIDE[side] },
      });
      ctx.ports.set(child, { portId, containerId: id, side });
      ctx.declaredPortIds.add(portId);
    } else if (isBoundaryPortChild(entity, child)) {
      // An explicit compass side wins. Otherwise (`auto`/omitted) we take the smart
      // side facing the exception target when one was found, and fall back to 90°
      // clockwise from the host's flow when it wasn't.
      const bs = child.boundarySide;
      const side =
        bs && bs !== 'auto' ? bs : ctx.boundaryAutoSide.get(child) ?? ROTATE_CW_90[flow];
      const caption = entityLabel(child);
      // The caption box (relative to the circle centre) drives both the reservation
      // and the draw, so they always agree. elk.port.anchor keeps the circle — and
      // the edge attaching to it — centred ON the border, over the reserved room.
      const half = EVENT_SIZE / 2;
      const labelBox = caption
        ? boundaryLabelBox(
            side,
            ctx.lineEntities.has(child),
            measureCaption(caption, ctx.measure),
            captionHeight(caption, LABEL_LINE_H),
          )
        : null;
      const ext = boundaryPortExtents(side, labelBox);
      const width = ext.left + ext.right;
      const height = ext.up + ext.down;
      const ax = ext.left;
      const ay = ext.up;
      // Reserve interior clearance on this side for the circle's inner half.
      inset[side] = half;
      ports.push({
        id: portId,
        width,
        height,
        layoutOptions: {
          'elk.port.side': ELK_PORT_SIDE[side],
          'elk.port.borderOffset': String(-half),
          'elk.port.anchor': `(${ax}, ${ay})`,
        },
      });
      ctx.ports.set(child, { portId, containerId: id, side });
      ctx.declaredPortIds.add(portId);
      ctx.boundaryEvents.set(portId, {
        op: child.eventOperation,
        resolved: ctx.resolved.get(child),
        caption,
        anchor: { ax, ay },
        labelBox,
      });
    } else {
      return;
    }
    // First declaration wins a name, matching the node branch in toElkNode.
    if (child.name && !ctx.byName.has(child.name)) ctx.byName.set(child.name, child);
  });
  if (inset.n || inset.e || inset.s || inset.w) ctx.boundaryInsetById.set(id, inset);
  return ports;
}

// Pins a built set of ports onto a node (leaf or container) and fixes their sides,
// so consecutive segments meet exactly and each port stays where it was declared.
export function attachPorts(node: ElkNode, ports: ElkPortSpec[]): void {
  if (ports.length === 0) return;
  (node as { ports?: unknown[] }).ports = ports;
  ((node.layoutOptions ??= {}) as Record<string, string>)['elk.portConstraints'] = 'FIXED_SIDE';
}

// A leaf entity becomes a fixed-size ELK node; a container becomes a compound
// node whose own layoutOptions carry its children's flow direction. ELK ignores
// `elk.direction` when a node has no edges, so we chain siblings with invisible
// ordering edges — never drawn, and sharing the `edges` array that real
// connections are later appended to. An entity whose only children are `port`s
// (or unsupported, skipped families) counts as a leaf: ports are border anchors,
// not boxes.
export function toElkNode(
  entity: Entity,
  id: string,
  inherited: Direction,
  ctx: BuildCtx,
  atRoot: boolean,
): ElkNode {
  ctx.types.set(id, entity.type);
  ctx.idOf.set(entity, id);
  ctx.entityById.set(id, entity);
  // First declaration wins a name, so absolute lines resolve deterministically.
  if (entity.name && !ctx.byName.has(entity.name)) {
    ctx.byName.set(entity.name, entity);
  }

  // The per-node icon and its size factor, threaded into sizing so the box
  // reserves room, and stashed for the draw pass via labelWidths below.
  const resolvedStyle = canHaveIcon(entity.type) ? ctx.resolved.get(entity) : undefined;
  const icon = resolvedStyle?.icon;
  const iconFactor = resolvedStyle?.iconSize;
  const caption = entityLabel(entity);
  if (caption) ctx.labelWidths.set(id, measureCaption(caption, ctx.measure));

  // The flow direction this entity sits in — its own if set, else inherited. It is
  // what children inherit, and what a pool/lane label band keys off. A pool's ELK
  // layout direction differs from its flow (it stacks lanes perpendicular), so the
  // two are tracked separately.
  const flow = entity.direction ?? inherited;
  if (entity.type === 'pool' || entity.type === 'lane') ctx.flowById.set(id, flow);
  if (entity.type === 'event' && entity.eventOperation) {
    ctx.eventOpById.set(id, entity.eventOperation);
  }
  if (entity.type === 'activity' && entity.activityType) {
    ctx.activityTypeById.set(id, entity.activityType);
  }
  if (entity.type === 'data') {
    ctx.dataTypeById.set(id, entity.dataType ?? 'object');
  }

  // Port-like children become ELK border ports on this node, not child boxes:
  // declared `port`s, and boundary events attached to an activity. Build them up
  // front so BOTH a leaf and a container carry them.
  const ports = declaredPorts(entity, id, ctx, flow);
  // Interior clearance for this host's boundary events (populated by declaredPorts).
  const bInset = ctx.boundaryInsetById.get(id) ?? NO_INSET;
  const isBoxChild = (c: Entity): boolean =>
    c.type !== 'port' && !isBoundaryPortChild(entity, c) && SUPPORTED_TYPES.has(c.type);
  const boxChildren = entity.children.filter(isBoxChild);
  const hasBoxChildren = boxChildren.length > 0;

  // The activity's bottom marker row (if any). An activity with no box children is
  // "collapsed" (drawn as a leaf), which is what a composite `+` marker keys off.
  const markerSpecs =
    entity.type === 'activity' ? activityMarkerSpecs(entity, !hasBoxChildren) : [];
  if (markerSpecs.length > 0) ctx.markerSpecsById.set(id, markerSpecs);
  const hasMarkers = markerSpecs.length > 0;

  // Builds this container's children, either directly or — for a black-box getting an
  // interior wrapper — inside one synthetic, layout-neutral INCLUDE region. The
  // wrapper gives the entity two hierarchy roles: it stays SEPARATE (a black box)
  // while the wrapper is INCLUDE-flattened, so a nested line can ELK-route to a
  // direct child's edge (an intermediate INCLUDE node) then bridge over the wrapper.
  // Declared ports stay on THIS node (built above); only box children move inside.
  // The declaration index is kept in each child's node id even across skipped
  // children (ports, unsupported families), so branch ordering stays stable.
  const buildChildren = (childFlow: Direction): ElkNode[] => {
    if (ctx.wrap.has(entity)) {
      const wrapper: Entity = { name: '', type: 'region', children: boxChildren };
      ctx.wrapperIds.add(`${id}.0`);
      return [toElkNode(wrapper, `${id}.0`, childFlow, ctx, false)];
    }
    const children: ElkNode[] = [];
    entity.children.forEach((child, i) => {
      if (!isBoxChild(child)) return;
      children.push(toElkNode(child, `${id}.${i}`, childFlow, ctx, false));
    });
    return children;
  };

  let node: ElkNode;
  if (!hasBoxChildren) {
    node = { id, ...leafSize(entity, ctx.measure, flow, icon, iconFactor, hasMarkers) };
    // Grow the leaf on each boundary-event side so a reserved strip sits between the
    // content (still centred in the original interior at draw time) and the border.
    node.width = (node.width ?? 0) + bInset.w + bInset.e;
    node.height = (node.height ?? 0) + bInset.n + bInset.s;
    attachPorts(node, ports);
  } else if (entity.type === 'pool' || entity.type === 'lane') {
    // A pool stacks its lanes PERPENDICULAR to the flow; a lane lays its content
    // out ALONG the flow. Either way children inherit the FLOW (a lane in an LR
    // pool flows LR). The label sits in a band on the flow's start edge; a pool
    // tiles its lanes flush (no padding, no gap), a lane pads its content a little.
    // Both PIN their direction (it is intrinsic to the swimlane, not inherited), so
    // the normalization pre-pass treats a branching lane as a real direction
    // boundary and no flatten can rotate the grid.
    const elkDir = entity.type === 'pool' ? TOGGLE_AXIS[flow] : flow;
    ctx.dirById.set(id, elkDir);
    ctx.explicitDirById.set(id, elkDir);
    const children = buildChildren(flow);
    ctx.topBandById.set(id, POOL_LABEL_BAND);
    const innerPad = entity.type === 'lane' ? CONTAINER_PAD : 0;
    const spacing = entity.type === 'lane' ? NODE_SPACING : 0;
    node = {
      id,
      layoutOptions: poolLaneOptions(elkDir, flow, POOL_LABEL_BAND, innerPad, spacing),
      children,
      edges: chainEdges(id, children),
    };
    if (caption) node.labels = [{ text: caption }];
    // A lane's label runs along its cross axis, so keep the lane at least as long
    // on that axis as the label — otherwise it overruns the box (a short, occupied
    // lane with a long name). The flow axis is left to ELK (the content sizes it).
    if (entity.type === 'lane' && caption) {
      const labelLen = (ctx.labelWidths.get(id) ?? 0) + LABEL_PAD_X;
      const horizontal = flow === 'LR' || flow === 'RL';
      const opts = node.layoutOptions as Record<string, string>;
      opts['elk.nodeSize.constraints'] = 'MINIMUM_SIZE';
      opts['elk.nodeSize.minimum'] = horizontal ? `(0, ${labelLen})` : `(${labelLen}, 0)`;
    }
    attachPorts(node, ports);
  } else {
    const direction = flow;
    ctx.dirById.set(id, direction);
    if (entity.direction !== undefined) ctx.explicitDirById.set(id, entity.direction);
    const children = buildChildren(direction);
    // A region carries no label band or border. A NESTED region also takes no
    // padding, so its children sit exactly where they would without the wrapper
    // and its fill is expanded to the parent's interior at draw time. A ROOT region
    // has no parent to expand into, so it pads around its own children like a
    // normal container. A captioned container reserves a top label band; an
    // uncaptioned one only needs the plain inner padding.
    const isRegion = entity.type === 'region';
    const regionPad = atRoot ? CONTAINER_PAD : 0;
    const wantsBand = !!caption || !!icon;
    const bandIconPx = icon ? iconPx(iconFactor, ICON_SIZE) : 0;
    // A multi-line heading grows the band by one line height per extra line, so the
    // rows stay inside the band and above the children.
    const bandCaptionH =
      CONTAINER_LABEL_BAND + (captionLines(caption).length - 1) * LABEL_LINE_H;
    const topBand = wantsBand
      ? Math.max(bandCaptionH, bandIconPx ? bandIconPx + ICON_GAP * 2 : 0)
      : isRegion
        ? regionPad
        : CONTAINER_PAD;
    ctx.topBandById.set(id, topBand);
    const sidePad = isRegion ? regionPad : CONTAINER_PAD;
    // An expanded activity container (a subprocess/transaction shown with its
    // children) still draws its loop/multi-instance marker along the bottom, so
    // reserve a band for it below the normal padding.
    const bottomPad = sidePad + (hasMarkers ? MARKER_BAND : 0);
    node = {
      id,
      layoutOptions: containerOptions(direction, topBand, sidePad, bottomPad, bInset),
      children,
      edges: chainEdges(id, children),
    };
    if (caption) node.labels = [{ text: caption }];
    // Pin any declared ports to this container's sides (like the routing ports do).
    attachPorts(node, ports);
  }

  ctx.nodeById.set(id, node);
  return node;
}

// A leaf's ELK label: text-only (positioned by us at draw time, for the box
// families) or sized+placed OUTSIDE (gateways/events, whose caption sits beside
// the shape and whose laid-out position the draw pass reads back).
export interface LeafLabel {
  text: string;
  width?: number;
  height?: number;
  layoutOptions?: Record<string, string>;
}
export interface LeafSize {
  width: number;
  height: number;
  labels?: LeafLabel[];
  layoutOptions?: Record<string, string>;
}

// The ELK label spec for a caption drawn OUTSIDE a gateway/event shape — below it
// in a horizontal flow, to its right in a vertical one. ELK reserves the room and
// positions the label; the draw pass reads the laid-out box back (see drawNode).
export function outsideLabel(
  caption: string,
  measure: Measure,
  flow: Direction,
): Pick<LeafSize, 'labels' | 'layoutOptions'> {
  if (!caption) return {};
  const horizontal = flow === 'LR' || flow === 'RL';
  const placement = horizontal ? 'OUTSIDE H_CENTER V_BOTTOM' : 'OUTSIDE H_RIGHT V_CENTER';
  return {
    labels: [
      {
        text: caption,
        width: measureCaption(caption, measure),
        height: captionHeight(caption, LABEL_LINE_H),
        layoutOptions: { 'org.eclipse.elk.nodeLabels.placement': placement },
      },
    ],
    layoutOptions: { 'org.eclipse.elk.spacing.labelNode': String(OUTSIDE_LABEL_GAP) },
  };
}

// Fixed dimensions (and a label) for a leaf entity. `icon`, when set, reserves
// room: a labelled box widens for a line-height icon before its caption; a
// label-less one sizes to a big icon it draws alone. `hasMarkers` reserves a
// bottom band for an activity's marker row, kept below its centred caption.
export function leafSize(
  entity: Entity,
  measure: Measure,
  flow: Direction,
  icon?: string,
  iconFactor?: number,
  hasMarkers = false,
): LeafSize {
  const caption = entityLabel(entity);
  const labelW = measureCaption(caption, measure);
  // Every extra caption line past the first adds one line height to the box, so a
  // multi-line caption is reserved room and never clipped.
  const extraLinesH = (captionLines(caption).length - 1) * LABEL_LINE_H;
  const markerBand = hasMarkers ? MARKER_BAND : 0;
  // Activities use a 50%-larger minimum box; other leaf families keep the base.
  const minW = entity.type === 'activity' ? ACTIVITY_MIN_W : LEAF_MIN_W;
  const minH = entity.type === 'activity' ? ACTIVITY_MIN_H : LEAF_H;
  // A gateway (diamond) and an event (circle) are fixed-size; their type marker is
  // drawn inside (see drawNode) and their caption OUTSIDE, beside the shape.
  if (entity.type === 'gate') {
    return { width: GATE_SIZE, height: GATE_SIZE, ...outsideLabel(caption, measure, flow) };
  }
  if (entity.type === 'event') {
    return { width: EVENT_SIZE, height: EVENT_SIZE, ...outsideLabel(caption, measure, flow) };
  }
  // A data element is a box (taller than wide by default) with its caption centred
  // inside; the shape (folded rectangle / cylinder) is drawn later. It grows wider
  // to fit a long caption (never narrower than DATA_W) and taller for a multi-line
  // caption so every row fits inside the shape.
  if (entity.type === 'data') {
    const width = Math.max(DATA_W, labelW + LABEL_PAD_X);
    return { width, height: DATA_H + extraLinesH, labels: [{ text: caption }] };
  }
  // A pool with no lanes, or a lane with no activities, is a fixed sharp box
  // oriented by its flow: the empty size (eight activity widths × two heights) for
  // a horizontal flow, swapped for a vertical one. A pool with no lanes centres its
  // label; a lane draws it in its start-edge band (both handled in drawNode).
  if (entity.type === 'pool' || entity.type === 'lane') {
    const horizontal = flow === 'LR' || flow === 'RL';
    // A lane draws its label in a band running along its CROSS axis (the short
    // one), so that axis grows to fit a long label; a pool with no lanes centres
    // its label along the long axis, which the fixed size already clears.
    const labelLen = entity.type === 'lane' && caption ? labelW + LABEL_PAD_X : 0;
    const cross = Math.max(POOL_MIN_H, labelLen);
    return {
      width: horizontal ? POOL_MIN_W : cross,
      height: horizontal ? cross : POOL_MIN_W,
      labels: [{ text: caption }],
    };
  }
  // A label-less box carrying an icon has no children either (it is a leaf), so it
  // draws the icon alone (twice line height by default) — size to clear it.
  if (icon && caption === '') {
    const size = iconPx(iconFactor, ICON_SIZE_LARGE);
    return {
      width: Math.max(minW, size + LABEL_PAD_X * 2),
      height: Math.max(minH, size + LABEL_PAD_X) + markerBand,
    };
  }
  // Otherwise reserve the caption's width plus, when present, the icon and its gap
  // drawn before the label; the box grows taller for a large icon so the label
  // (vertically centred to it) still fits, taller for extra caption lines, and
  // taller again for a marker row.
  const size = icon ? iconPx(iconFactor, ICON_SIZE) : 0;
  const iconExtra = size ? size + ICON_GAP : 0;
  return {
    width: Math.max(minW, labelW + LABEL_PAD_X * 2 + iconExtra),
    height: Math.max(minH + extraLinesH, size ? size + LABEL_PAD_X : 0) + markerBand,
    labels: [{ text: caption }],
  };
}

// One resolved line endpoint. `elk` is what an ELK edge attaches to (a node id, or
// a port id for a declared port); `owner` is the node id that governs the edge's
// LCA (the node itself, or a port's container). `entity` carries the family for the
// data-association / message-flow decisions.
export interface EndpointRef {
  elk: string;
  owner: string;
  isPort: boolean;
  entity: Entity;
  // For a port endpoint (a declared `port` or a boundary event): the edge it is
  // pinned to. Fed to planRoute so the bend axis follows the port's side.
  side?: Side;
}

// Resolves a line endpoint entity to its ELK/owner ids, or null when it is unknown
// (undefined entity) or was never built into a node (e.g. a skipped, unsupported
// entity). A port resolves to its ELK port; anything else to its node.
export function resolveEndpoint(entity: Entity | undefined, ctx: BuildCtx): EndpointRef | null {
  if (!entity) return null;
  const port = ctx.ports.get(entity);
  if (port) {
    return { elk: port.portId, owner: port.containerId, isPort: true, entity, side: port.side };
  }
  const id = ctx.idOf.get(entity);
  if (!id) return null;
  return { elk: id, owner: id, isPort: false, entity };
}

// Every entity referenced by at least one line, resolved through a first-wins name
// index over the whole tree (as endpoints resolve elsewhere). A boundary event reads
// it to know whether it has a line, and so must move its caption clear of it. Built
// before the ELK tree, since sizing a boundary port depends on the answer.
export function collectLineEntities(root: Entity, lines: Line[]): Set<Entity> {
  const nameIndex = new Map<string, Entity>();
  const indexNames = (e: Entity): void => {
    if (e.name && !nameIndex.has(e.name)) nameIndex.set(e.name, e);
    e.children.forEach(indexNames);
  };
  root.children.forEach(indexNames);
  const out = new Set<Entity>();
  for (const line of lines) {
    const s = typeof line.source === 'string' ? nameIndex.get(line.source) : line.source;
    const t = typeof line.target === 'string' ? nameIndex.get(line.target) : line.target;
    if (s) out.add(s);
    if (t) out.add(t);
  }
  return out;
}

// Attaches a line's caption to an ELK edge so ELK lays it out and reserves space
// for it (no overlap with boxes). `TAIL` — set on the LABEL, where elkjs actually
// honors it (on the edge it settles the label mid-edge) — biases it toward the
// edge's SOURCE end, i.e. "closer to source than target". The size is measured NOW,
// while the text probe is still in the DOM (see makeMeasurer / the draw's `done()`
// timing); the draw pass reads the laid-out box back and renders the text there.
export function applyEdgeLabel(edge: LabelableEdge, text: string, measure: Measure): void {
  edge.labels = [
    {
      id: `${edge.id}L`,
      text,
      width: measureCaption(text, measure, LINE_LABEL_CLASS),
      height: captionHeight(text, LABEL_LINE_H),
      layoutOptions: { 'org.eclipse.elk.edgeLabels.placement': 'TAIL' },
    },
  ];
}

// The explicit stroke a line should draw with, or undefined for the theme default.
// A relative line inherits from the entity it was written inside; an absolute line
// from the entity at the endpoints' lowest common ancestor.
export function lineStroke(
  line: Line,
  lca: string,
  ctx: BuildCtx,
  resolved: Map<Entity, Resolved>,
): string | undefined {
  if (line.style?.stroke) return line.style.stroke;
  const containerEntity =
    line.container ?? (lca === '' ? null : ctx.entityById.get(lca) ?? null);
  return containerEntity ? resolved.get(containerEntity)?.strokeExplicit : undefined;
}

// The id of the pool a node sits in — the nearest ancestor of type `pool` (or the
// node itself when it is one), or undefined when it sits in no pool. Node ids are
// dot-paths, so ancestors are just prefixes. Used to tell a message flow (crossing
// pools) from an ordinary sequence flow.
export function poolOf(id: string, ctx: BuildCtx): string | undefined {
  const parts = id.split('.');
  for (let i = parts.length; i >= 1; i--) {
    const prefix = parts.slice(0, i).join('.');
    if (ctx.types.get(prefix) === 'pool') return prefix;
  }
  return undefined;
}

// Read-only indexes the draw pass needs, plus `regionRects`/`laneRects` — scratch
// maps it fills top-down with each region's interior-tiling fill rect and each
// lane's pool-fitted box (keyed by node id) so the child draws with the box its
// parent computed for it.
export interface DrawCtx {
  types: Map<string, EntityType>;
  resolvedById: Map<string, Resolved>;
  regionRects: Map<string, Rect>;
  // Lane draw-boxes: a pool stretches each lane along its flow axis to span the
  // pool's content, so the lanes tile it edge to edge. Keyed by node id; the lane's
  // children still position from their laid-out (ELK) origin, like region fills.
  laneRects: Map<string, Rect>;
  // The FLOW direction of each pool/lane (see BuildCtx), by node id — for the label
  // band's edge and rotation.
  flowById: Map<string, Direction>;
  // Each event's operation (see BuildCtx), by node id — for the circle outline.
  eventOpById: Map<string, EventOperation>;
  // Each activity's type (see BuildCtx), by node id — for the box outline variant.
  activityTypeById: Map<string, ActivityType>;
  // Each activity's bottom marker row (see BuildCtx), as bpmn icon specs, by node id.
  markerSpecsById: Map<string, string[]>;
  // Each data element's type (see BuildCtx), by node id — for the shape variant.
  dataTypeById: Map<string, DataType>;
  // Resolved icon SVG by `pack:name` spec, and rendered caption width by node id.
  icons: Map<string, IconSvg>;
  labelWidths: Map<string, number>;
  // The top band each container reserved for its heading (see BuildCtx), by node id.
  topBandById: Map<string, number>;
  // When true (the root-only `debug ports` directive), draw routing ports as
  // small red squares; otherwise they stay invisible.
  debugPorts: boolean;
  // Ids of the ports that came from a declared `port` entity (rather than the line
  // router). Under the debug overlay these draw green.
  declaredPortIds: Set<string>;
  // Per host node id, the interior clearance reserved on each boundary-event side
  // (see BuildCtx) — so the caption and markers shift clear of the reserved strip.
  boundaryInsetById: Map<string, BoundaryInset>;
  // The resolved bracket edge for each text annotation, by node id (auto sides are
  // resolved against the laid-out geometry before the draw pass).
  bracketSideById: Map<string, Side>;
  // Under `debug ports`: node ids of black-boxed (SEPARATE_CHILDREN) containers, so
  // the draw pass can overlay them with a dashed outline. Empty when the overlay is off.
  debugBlackBoxIds: Set<string>;
  // Under `debug ports`: node ids of the synthetic interior wrapper regions, so the
  // draw pass can tint them translucent magenta. Empty when the overlay is off.
  debugWrapperIds: Set<string>;
}

// Orders a sibling list so region subtrees come first. SVG has no z-index — paint
// order is document order — so drawing regions before their siblings keeps a
// region's fill beneath the boxes that share its container. Stable.
export function regionsFirst(nodes: ElkNode[], types: Map<string, EntityType>): ElkNode[] {
  const isRegion = (n: ElkNode) => types.get(n.id) === 'region';
  const regions = nodes.filter(isRegion);
  if (regions.length === 0 || regions.length === nodes.length) return nodes;
  return [...regions, ...nodes.filter((n) => !isRegion(n))];
}

// Extends every root pool that shares a flow direction to a common length — the
// longest in that group — along its flow axis, the same way a pool stretches all
// its lanes to one length. ELK sizes each pool to its own content, so a stack of
// pools ends up ragged; here we read those laid-out lengths, pin the shorter pools
// to the group maximum as a minimum size, and report whether anything changed so
// the caller can lay the graph out once more (letting ELK re-place the content and
// re-align the stack). Pools of different directions are grown independently — an
// LR pool matches other LR pools' widths, a TB pool other TB pools' heights.
export function equalisePoolLengths(laid: ElkNode, ctx: BuildCtx): boolean {
  const pools = (laid.children ?? []).filter((n) => ctx.types.get(n.id as string) === 'pool');
  if (pools.length < 2) return false;
  const isHorizontal = (n: ElkNode): boolean => {
    const flow = ctx.flowById.get(n.id as string) ?? 'TB';
    return flow === 'LR' || flow === 'RL';
  };
  const flowLen = (n: ElkNode): number => (isHorizontal(n) ? n.width ?? 0 : n.height ?? 0);
  // The longest pool per flow direction (its flow-axis extent).
  const maxByFlow = new Map<Direction, number>();
  for (const p of pools) {
    const flow = ctx.flowById.get(p.id as string) ?? 'TB';
    maxByFlow.set(flow, Math.max(maxByFlow.get(flow) ?? 0, flowLen(p)));
  }
  let changed = false;
  for (const p of pools) {
    const flow = ctx.flowById.get(p.id as string) ?? 'TB';
    const target = maxByFlow.get(flow) ?? 0;
    // Already the longest (allow for sub-pixel rounding) — leave it alone.
    if (flowLen(p) >= target - 0.5) continue;
    // Pin the flow axis to the group maximum; keep the cross axis as laid (a
    // MINIMUM_SIZE floor never shrinks it, and content can still grow it).
    const minW = isHorizontal(p) ? target : p.width ?? 0;
    const minH = isHorizontal(p) ? p.height ?? 0 : target;
    const opts = (p.layoutOptions ??= {}) as Record<string, string>;
    opts['elk.nodeSize.constraints'] = 'MINIMUM_SIZE';
    opts['elk.nodeSize.minimum'] = `(${minW},${minH})`;
    changed = true;
  }
  return changed;
}

// Builds a nested <svg> holding one resolved icon, positioned at (x, y) at the
// given size. `currentColor` in the body picks up the `.bpmn-icon` text color.
export function iconEl(icon: IconSvg, x: number, y: number, size: number): SVGElement {
  const el = svgEl('svg', {
    x,
    y,
    width: size,
    height: size,
    viewBox: icon.viewBox,
    class: 'bpmn-icon',
  });
  el.innerHTML = icon.body;
  return el;
}

// Builds a centred `[icon] caption` group whose overall centre is the local origin
// (0, 0); the caller positions it with a transform on the returned <g>. Either
// part may be absent: icon-only, or text-only. A multi-line caption stacks its rows
// centred on that origin.
export function iconLabelContent(
  iconSvg: IconSvg | undefined,
  iconSize: number,
  caption: string,
  labelClass: string,
  labelWidth: number,
): SVGGElement {
  const g = svgEl('g', {});
  const iconW = iconSvg ? iconSize : 0;
  const gap = iconSvg && caption ? ICON_GAP : 0;
  const left = -(iconW + gap + labelWidth) / 2;
  if (iconSvg) g.appendChild(iconEl(iconSvg, left, -iconSize / 2, iconSize));
  if (caption) {
    g.appendChild(
      captionText(caption, left + iconW + gap + labelWidth / 2, labelClass, LABEL_LINE_H),
    );
  }
  return g;
}

// Draws a pool/lane label inside its band — the strip along the flow's start edge
// (west for LR, east for RL, north for TB, south for BT), rotated to run along the
// band (bottom-to-top on a side band, horizontal on a top/bottom band).
export function drawBandLabel(
  svg: SVGSVGElement,
  box: Rect,
  flow: Direction,
  caption: string,
  labelWidth: number,
): void {
  const side = BAND_SIDE[flow];
  const half = POOL_LABEL_BAND / 2;
  const cx = side === 'w' ? box.x + half : side === 'e' ? box.x + box.w - half : box.x + box.w / 2;
  const cy = side === 'n' ? box.y + half : side === 's' ? box.y + box.h - half : box.y + box.h / 2;
  const g = iconLabelContent(undefined, 0, caption, 'bpmn-label', labelWidth);
  g.setAttribute('transform', `translate(${cx} ${cy}) rotate(${LABEL_ROT[flow]})`);
  svg.appendChild(g);
}

// Draws a gateway/event caption in the OUTSIDE label box ELK laid out beside the
// shape (see outsideLabel). The label's position is relative to the node origin.
export function drawOutsideLabel(
  svg: SVGSVGElement,
  node: ElkNode,
  x: number,
  y: number,
): void {
  const lbl = (
    node as {
      labels?: { text?: string; x?: number; y?: number; width?: number; height?: number }[];
    }
  ).labels?.[0];
  if (!lbl?.text) return;
  const cx = x + (lbl.x ?? 0) + (lbl.width ?? 0) / 2;
  const cy = y + (lbl.y ?? 0) + (lbl.height ?? 0) / 2;
  svg.appendChild(captionText(lbl.text, cx, 'bpmn-label', LABEL_LINE_H, cy));
}

// Draws an event's circle(s), their outline chosen by the event operation: a thin
// single ring for a start, a bold single ring for an end, a thin double ring for an
// intermediate (catch/throw) or boundary event, and a dashed ring for a
// non-interrupting one (single dashed for a start, double dashed for a boundary).
// The type marker is drawn on top separately (see drawNode).
export function drawEventShape(
  svg: SVGSVGElement,
  box: Rect,
  resolved: Resolved | undefined,
  op: EventOperation | undefined,
): void {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const fill = resolved?.fill ?? 'transparent';
  const stroke = resolved?.strokeExplicit;
  const dashed = op === 'non-interrupt' || op === 'boundary-non-interrupt';
  const doubled =
    op === 'catch' || op === 'throw' || op === 'boundary' || op === 'boundary-non-interrupt';
  const sw = op === 'end' ? EVENT_THICK : ACTIVITY_STROKE;
  const outerR = box.w / 2 - sw / 2;
  const ring = (r: number, filled: boolean): SVGElement => {
    let s = `fill:${filled ? fill : 'none'}`;
    if (stroke) s += `;stroke:${stroke}`;
    if (sw !== ACTIVITY_STROKE) s += `;stroke-width:${sw}`;
    if (dashed) s += `;stroke-dasharray:${EVENT_DASH}`;
    return svgEl('circle', { cx, cy, r, style: s, class: classFor('event', false) });
  };
  svg.appendChild(ring(outerR, true));
  if (doubled) svg.appendChild(ring(outerR - EVENT_DOUBLE_GAP, false));
}

// Draws a boundary event centred on the host activity's border: the event circle
// (a double ring, dashed for a non-interrupting one), its type glyph, and its
// caption placed just OUTSIDE the circle on the side it pins to. Drawn last, over
// the activity and any edge stub, so the circle reads as sitting on the border.
export function drawBoundaryEvent(
  svg: SVGSVGElement,
  box: Rect,
  be: BoundaryEvent,
  icons: Map<string, IconSvg>,
): void {
  drawEventShape(svg, box, be.resolved, be.op);
  const iconSvg = be.resolved?.icon ? icons.get(be.resolved.icon) : undefined;
  if (iconSvg) {
    svg.appendChild(
      iconEl(
        iconSvg,
        box.x + box.w / 2 - EVENT_ICON / 2,
        box.y + box.h / 2 - EVENT_ICON / 2,
        EVENT_ICON,
      ),
    );
  }
  if (be.caption && be.labelBox) {
    const cx = box.x + box.w / 2;
    const cy = box.y + box.h / 2;
    const b = be.labelBox;
    // Anchor the text at the box edge nearest the circle: left/right/centred by
    // where the box sits horizontally, top/bottom/centred by where it sits
    // vertically. The box was sized to the text, so this reproduces its placement.
    const horiz =
      b.left >= -0.01
        ? { x: cx + b.left, anchor: 'start' }
        : b.right <= 0.01
          ? { x: cx + b.right, anchor: 'end' }
          : { x: cx + (b.left + b.right) / 2, anchor: 'middle' };
    const vert =
      b.top >= -0.01
        ? { y: cy + b.top, baseline: 'hanging' }
        : b.bottom <= 0.01
          ? { y: cy + b.bottom, baseline: 'auto' }
          : { y: cy + (b.top + b.bottom) / 2, baseline: 'central' };
    svg.appendChild(
      boundaryCaption(be.caption, horiz.x, vert.y, horiz.anchor, vert.baseline),
    );
  }
}

// A boundary event's caption. Unlike every other caption it is anchored to an EDGE
// of its reserved box rather than centred in it (the box was placed to clear both
// the host and the exception line), so it needs its own row stacking: rows grow away
// from the anchored edge — a top-anchored (hanging) caption steps DOWN from its
// first row, a bottom-anchored (auto) one is lifted so its rows end at the anchor,
// and a centred one is balanced about it.
function boundaryCaption(
  caption: string,
  x: number,
  y: number,
  anchor: string,
  baseline: string,
): SVGTextElement {
  const text = svgEl('text', {
    x,
    y,
    'text-anchor': anchor,
    'dominant-baseline': baseline,
    class: 'bpmn-label',
  });
  const lines = captionLines(caption);
  if (lines.length === 1) {
    text.textContent = caption;
    return text;
  }
  const firstDy =
    baseline === 'hanging'
      ? 0
      : baseline === 'auto'
        ? -(lines.length - 1) * LABEL_LINE_H
        : -((lines.length - 1) * LABEL_LINE_H) / 2;
  lines.forEach((line, i) => {
    const tspan = svgEl('tspan', { x, y: y + firstDy + i * LABEL_LINE_H });
    tspan.textContent = line;
    text.appendChild(tspan);
  });
  return text;
}

// Draws an activity's rounded-rectangle outline, its border chosen by the activity
// type: `task`/`subprocess` keep the plain single border; `call` and
// `call-subprocess` get a bold (double width) one; `event-subprocess` a dotted one;
// `transaction` a double outline drawn with thinner lines (an inner rect inset from
// the outer). The fill rides on the outer/only rect; the transaction's inner rect is
// unfilled so the fill shows through the gap between the two lines.
export function drawActivityShape(
  svg: SVGSVGElement,
  box: Rect,
  resolved: Resolved | undefined,
  isContainer: boolean,
  activityType: ActivityType | undefined,
): void {
  const fill = resolved?.fill ?? 'transparent';
  const stroke = resolved?.strokeExplicit;
  const cls = classFor('activity', isContainer);
  // One rounded rect inset `pad` from the box, with an optional stroke-width and
  // dash override; `filled` carries the entity fill, otherwise the interior is left
  // clear (the transaction's inner ring). The radius shrinks with the inset so the
  // two rects stay concentric.
  const rect = (pad: number, filled: boolean, sw?: number, dash?: string): SVGElement => {
    let s = `fill:${filled ? fill : 'none'}`;
    if (stroke) s += `;stroke:${stroke}`;
    if (sw !== undefined) s += `;stroke-width:${sw}`;
    if (dash) s += `;stroke-dasharray:${dash}`;
    return svgEl('rect', {
      x: box.x + pad,
      y: box.y + pad,
      width: box.w - pad * 2,
      height: box.h - pad * 2,
      rx: Math.max(0, ACTIVITY_RADIUS - pad),
      ry: Math.max(0, ACTIVITY_RADIUS - pad),
      style: s,
      class: cls,
    });
  };

  switch (activityType) {
    case 'call':
    case 'call-subprocess':
      svg.appendChild(rect(0, true, ACTIVITY_THICK));
      break;
    case 'event-subprocess':
      svg.appendChild(rect(0, true, undefined, ACTIVITY_DOTTED));
      break;
    case 'transaction':
      svg.appendChild(rect(0, true, ACTIVITY_DOUBLE_STROKE));
      svg.appendChild(rect(ACTIVITY_DOUBLE_GAP, false, ACTIVITY_DOUBLE_STROKE));
      break;
    default:
      svg.appendChild(rect(0, true));
  }
}

// Draws a data element. A data OBJECT is a rectangle with its top-right corner
// folded — the outline cuts that corner off, and the dog-ear crease is drawn as a
// separate stroke on top. A data STORE is a cylinder: a filled silhouette (over
// the top, down the sides, front curve across the bottom) plus the visible front
// edge of its top lid. Fill/stroke follow the resolved style like every other box.
export function drawDataShape(
  svg: SVGSVGElement,
  box: Rect,
  resolved: Resolved | undefined,
  dataType: DataType | undefined,
): void {
  const fill = resolved?.fill ?? 'transparent';
  const stroke = resolved?.strokeExplicit;
  const cls = classFor('data', false);
  const filled = stroke ? `fill:${fill};stroke:${stroke}` : `fill:${fill}`;
  const line = stroke ? `fill:none;stroke:${stroke}` : 'fill:none';
  const L = box.x;
  const R = box.x + box.w;
  const T = box.y;
  const B = box.y + box.h;

  if (dataType === 'store') {
    const rx = box.w / 2;
    const ry = DATA_LID_RY;
    // Silhouette: over the top ellipse, down the right, front curve along the
    // bottom, up the left (closed). The top arc is the back rim of the lid.
    const body =
      `M ${L},${T + ry} A ${rx},${ry} 0 0 1 ${R},${T + ry}` +
      ` L ${R},${B - ry} A ${rx},${ry} 0 0 1 ${L},${B - ry} Z`;
    svg.appendChild(svgEl('path', { d: body, style: filled, class: cls }));
    // The front edge of the top lid (the bottom half of the top ellipse).
    const lid = `M ${L},${T + ry} A ${rx},${ry} 0 0 0 ${R},${T + ry}`;
    svg.appendChild(svgEl('path', { d: lid, style: line, class: cls }));
    return;
  }

  // Data object (and its `collection` flavor): the outline cuts the top-right
  // corner, then the fold is drawn.
  const f = DATA_FOLD;
  const outline = `${L},${T} ${R - f},${T} ${R},${T + f} ${R},${B} ${L},${B}`;
  svg.appendChild(svgEl('polygon', { points: outline, style: filled, class: cls }));
  const fold = `${R - f},${T} ${R - f},${T + f} ${R},${T + f}`;
  svg.appendChild(svgEl('polyline', { points: fold, style: line, class: cls }));

  // A collection is a data object carrying the multi-instance parallel marker:
  // three short vertical bars centred along the bottom edge (mirroring the
  // `mi-parallel` activity marker).
  if (dataType === 'collection') {
    const cx = (L + R) / 2;
    const bh = DATA_COLLECTION_BAR_H;
    const barB = B - DATA_COLLECTION_GAP;
    const barT = barB - bh;
    const gap = DATA_COLLECTION_BAR_GAP;
    for (const dx of [-gap, 0, gap]) {
      svg.appendChild(
        svgEl('line', { x1: cx + dx, y1: barT, x2: cx + dx, y2: barB, style: line, class: cls }),
      );
    }
  }
}

// Draws a text annotation: a transparent box (painted only when a `fill` is set)
// with a bold, open bracket on one edge. `side` is which edge — a `[` on the west,
// `]` on the east, and the top/bottom variants — the BPMN text-annotation cue. The
// bracket takes the resolved stroke, or the theme default.
export function drawTextShape(
  svg: SVGSVGElement,
  box: Rect,
  resolved: Resolved | undefined,
  side: Side,
): void {
  const fill = resolved?.fill;
  const stroke = resolved?.strokeExplicit;
  // Transparent unless a real fill is set (styleModel yields 'transparent' for an
  // unstyled text box); then a borderless background rect.
  if (fill && fill !== 'transparent') {
    svg.appendChild(
      svgEl('rect', {
        x: box.x,
        y: box.y,
        width: box.w,
        height: box.h,
        style: `fill:${fill};stroke:none`,
        class: 'bpmn-text',
      }),
    );
  }
  const cap = Math.min(TEXT_BRACKET_CAP, box.w / 3, box.h / 3);
  const L = box.x;
  const R = box.x + box.w;
  const T = box.y;
  const B = box.y + box.h;
  let points: string;
  switch (side) {
    case 'e':
      points = `${R - cap},${T} ${R},${T} ${R},${B} ${R - cap},${B}`;
      break;
    case 'n':
      points = `${L},${T + cap} ${L},${T} ${R},${T} ${R},${T + cap}`;
      break;
    case 's':
      points = `${L},${B - cap} ${L},${B} ${R},${B} ${R},${B - cap}`;
      break;
    default: // 'w'
      points = `${L + cap},${T} ${L},${T} ${L},${B} ${L + cap},${B}`;
  }
  let s = `fill:none;stroke-width:${TEXT_BRACKET_STROKE}`;
  if (stroke) s += `;stroke:${stroke}`;
  svg.appendChild(svgEl('polyline', { points, style: s, class: 'bpmn-entity bpmn-text' }));
}

// The side of `from`'s box that faces `to`'s box — the axis of greater centre-to-
// centre separation, then its sign. Used to point a text annotation's bracket at a
// connected entity when its side is `auto` and it has no ports.
export function nearestSide(from: AbsRect, to: AbsRect): Side {
  const dx = to.x + to.w / 2 - (from.x + from.w / 2);
  const dy = to.y + to.h / 2 - (from.y + from.h / 2);
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'e' : 'w';
  return dy >= 0 ? 's' : 'n';
}

// Picks the edge each text annotation draws its bracket on, once the boxes are laid
// out. Priority: an explicit side token (`bracketSide`); else the first declared
// port's side; else the side facing the first entity connected to it; else west.
// Returns a per-node-id map the draw pass reads; empty (and cheap) when the diagram
// has no annotations.
export function resolveBracketSides(
  ctx: BuildCtx,
  lines: Line[],
  laid: ElkNode,
): Map<string, Side> {
  const sides = new Map<string, Side>();
  const texts = [...ctx.entityById].filter(([, e]) => e.type === 'text');
  if (texts.length === 0) return sides;

  const absRects = new Map<string, AbsRect>();
  const portPoints = new Map<string, { x: number; y: number }>();
  for (const node of laid.children ?? []) collectAbsRects(node, 0, 0, absRects, portPoints);

  const resolveEp = (ep: Entity | string): Entity | undefined =>
    typeof ep === 'string' ? ctx.byName.get(ep) : ep;

  for (const [id, entity] of texts) {
    if (entity.bracketSide) {
      sides.set(id, entity.bracketSide);
      continue;
    }
    const port = entity.children.find((c) => c.type === 'port' && c.portSide);
    if (port?.portSide) {
      sides.set(id, port.portSide);
      continue;
    }
    const self = absRects.get(id);
    let picked: Side | undefined;
    if (self) {
      for (const line of lines) {
        const s = resolveEp(line.source);
        const t = resolveEp(line.target);
        const other = s === entity ? t : t === entity ? s : undefined;
        if (!other || other === entity) continue;
        const otherId = ctx.idOf.get(other);
        const orect = otherId ? absRects.get(otherId) : undefined;
        if (orect) {
          picked = nearestSide(self, orect);
          break;
        }
      }
    }
    sides.set(id, picked ?? 'w');
  }
  return sides;
}

// Draws an activity's marker glyphs as a row centred along the bottom edge of its
// box (within the MARKER_BAND the build pass reserved). Only glyphs that resolved
// are drawn; the row is centred on however many that is.
export function drawMarkers(
  svg: SVGSVGElement,
  box: Rect,
  specs: string[],
  icons: Map<string, IconSvg>,
  inset: BoundaryInset = NO_INSET,
): void {
  const glyphs = specs.map((s) => icons.get(s)).filter((g): g is IconSvg => !!g);
  if (glyphs.length === 0) return;
  const totalW = glyphs.length * MARKER_SIZE + (glyphs.length - 1) * MARKER_GAP;
  // Centre the row in the content region (inside any reserved boundary-event strips)
  // and lift it above a south strip.
  let mx = box.x + (box.w + inset.w - inset.e) / 2 - totalW / 2;
  const my = box.y + box.h - inset.s - (MARKER_BAND + MARKER_SIZE) / 2;
  for (const g of glyphs) {
    svg.appendChild(iconEl(g, mx, my, MARKER_SIZE));
    mx += MARKER_SIZE + MARKER_GAP;
  }
}

// Recursively draws laid-out nodes. ELK reports child coordinates relative to
// their parent, so we thread an accumulated (ox, oy) offset down the tree.
export function drawNode(
  svg: SVGSVGElement,
  node: ElkNode,
  ox: number,
  oy: number,
  ctx: DrawCtx,
): void {
  const x = ox + (node.x ?? 0);
  const y = oy + (node.y ?? 0);
  const w = node.width ?? 0;
  const h = node.height ?? 0;
  const type = ctx.types.get(node.id) ?? 'activity';
  const isContainer = (node.children?.length ?? 0) > 0;
  const resolved = ctx.resolvedById.get(node.id);

  // A region's box is expanded to tile its parent's interior, and a lane's is
  // stretched by its pool to span the flow axis (see the child passes below); every
  // other node draws at its laid-out box.
  const box = ctx.laneRects.get(node.id) ?? ctx.regionRects.get(node.id) ?? { x, y, w, h };
  if (type === 'event') {
    drawEventShape(svg, box, resolved, ctx.eventOpById.get(node.id as string));
  } else if (type === 'activity') {
    drawActivityShape(svg, box, resolved, isContainer, ctx.activityTypeById.get(node.id as string));
  } else if (type === 'data') {
    drawDataShape(svg, box, resolved, ctx.dataTypeById.get(node.id as string));
  } else if (type === 'text') {
    drawTextShape(svg, box, resolved, ctx.bracketSideById.get(node.id as string) ?? 'w');
  } else {
    svg.appendChild(shapeFor(type, box.x, box.y, box.w, box.h, resolved, isContainer));
  }

  // Debug overlay (see docs/routing.md): a synthetic interior wrapper region gets a
  // translucent magenta fill (drawn first, beneath its children — regions paint
  // before their siblings) so the inserted INCLUDE region is visible.
  if (ctx.debugPorts && ctx.debugWrapperIds.has(node.id)) {
    svg.appendChild(
      svgEl('rect', {
        x: box.x,
        y: box.y,
        width: box.w,
        height: box.h,
        style: `fill:${DEBUG_WRAPPER_FILL};fill-opacity:${DEBUG_WRAPPER_OPACITY};stroke:none`,
        class: 'bpmn-debug-wrapper',
      }),
    );
  }
  // A black-boxed (SEPARATE_CHILDREN) container gets a dash-dash-dot-dot outline so
  // it reads as "laid out on its own".
  if (ctx.debugPorts && ctx.debugBlackBoxIds.has(node.id)) {
    const outline: Record<string, string | number> = {
      x: box.x,
      y: box.y,
      width: box.w,
      height: box.h,
      style: `fill:none;stroke:${DEBUG_BLACKBOX_STROKE};stroke-width:2;stroke-dasharray:${DEBUG_BLACKBOX_DASH}`,
      class: 'bpmn-debug-blackbox',
    };
    // Follow the box's own corner rounding so the overlay hugs the shape.
    const r = type === 'activity' ? ACTIVITY_RADIUS : type === 'group' ? GROUP_CORNER : 0;
    if (r > 0) {
      outline.rx = r;
      outline.ry = r;
    }
    svg.appendChild(svgEl('rect', outline));
  }

  // Interior clearance reserved for this host's boundary events; shifts the caption
  // and markers off the strips where the boundary circles' inner halves sit.
  const inset = ctx.boundaryInsetById.get(node.id as string) ?? NO_INSET;

  // BPMN activity markers: a row of glyphs centred along the box's bottom edge.
  const markerSpecs = ctx.markerSpecsById.get(node.id as string);
  if (markerSpecs) drawMarkers(svg, box, markerSpecs, ctx.icons, inset);

  // Ports are created zero-size for routing and are otherwise invisible. Under the
  // `debug ports` directive, draw each as a small square: declared ports green,
  // the router's own ports red.
  if (ctx.debugPorts) {
    const PORT_MARK = 6;
    for (const port of (node as { ports?: { id: string; x?: number; y?: number }[] }).ports ?? []) {
      const px = x + (port.x ?? 0);
      const py = y + (port.y ?? 0);
      const declared = ctx.declaredPortIds.has(port.id);
      svg.appendChild(
        svgEl('rect', {
          x: px - PORT_MARK / 2,
          y: py - PORT_MARK / 2,
          width: PORT_MARK,
          height: PORT_MARK,
          style: `fill:${declared ? '#00c853' : '#ff0000'};stroke:none`,
          class: declared ? 'bpmn-port bpmn-port-declared' : 'bpmn-port',
        }),
      );
    }
  }

  // The caption to draw (empty for a port or an entity given an explicit `""`) and
  // the per-node icon. Both are drawn inside the box — centred in a leaf, or in
  // the top label band of a container.
  const caption = node.labels?.[0]?.text ?? '';
  const iconSpec = canHaveIcon(type) ? resolved?.icon : undefined;
  const iconSvg = iconSpec ? ctx.icons.get(iconSpec) : undefined;
  const iconFactor = canHaveIcon(type) ? resolved?.iconSize : undefined;

  // A pool with lanes, and every lane, draw their caption in a rotated side band;
  // a pool with no lanes (a leaf) centres it like any other box.
  const banded = type === 'lane' || (type === 'pool' && isContainer);
  if (banded) {
    if (caption) {
      const flow = ctx.flowById.get(node.id as string) ?? 'LR';
      drawBandLabel(svg, box, flow, caption, ctx.labelWidths.get(node.id as string) ?? 0);
    }
  } else if (type === 'gate') {
    // A gateway draws its type marker (from the bpmn pack, chosen by gate type)
    // centred in the diamond, and its caption (if any) outside, beside the shape.
    if (iconSvg) {
      svg.appendChild(
        iconEl(iconSvg, x + w / 2 - GATE_ICON / 2, y + h / 2 - GATE_ICON / 2, GATE_ICON),
      );
    }
    drawOutsideLabel(svg, node, x, y);
  } else if (type === 'event') {
    // An event draws its type marker (chosen by event type + operation) centred in
    // the circle (a blank event has none — just the ring), and its caption outside.
    if (iconSvg) {
      svg.appendChild(
        iconEl(iconSvg, x + w / 2 - EVENT_ICON / 2, y + h / 2 - EVENT_ICON / 2, EVENT_ICON),
      );
    }
    drawOutsideLabel(svg, node, x, y);
  } else if (type === 'pool') {
    // An empty pool (no lanes) centres its label, rotated to run along the long
    // (flow) axis — horizontal for LR/RL, 90° CCW for a vertical TB/BT pool so it
    // doesn't overrun the narrow box.
    if (caption || iconSvg) {
      const flow = ctx.flowById.get(node.id as string) ?? 'LR';
      const vertical = flow === 'TB' || flow === 'BT';
      const labelWidth = caption ? ctx.labelWidths.get(node.id as string) ?? 0 : 0;
      const g = iconLabelContent(
        iconSvg,
        iconPx(iconFactor, ICON_SIZE),
        caption,
        'bpmn-label',
        labelWidth,
      );
      g.setAttribute(
        'transform',
        `translate(${x + w / 2} ${y + h / 2})${vertical ? ' rotate(-90)' : ''}`,
      );
      svg.appendChild(g);
    }
  } else if (drawsInternalLabel(type) && (caption || iconSvg)) {
    const bandH = ctx.topBandById.get(node.id as string) ?? CONTAINER_LABEL_BAND;
    // A leaf activity's caption centres in the region ABOVE its marker band (a
    // container labels its top band instead, so its bottom markers don't shift it).
    // Boundary-event strips are excluded from the centring region on every side, so
    // the caption never slides under a boundary circle's inner half.
    const leafMarkerBand = !isContainer && markerSpecs ? MARKER_BAND : 0;
    const centerX = x + (w + inset.w - inset.e) / 2;
    const centerY = isContainer
      ? y + inset.n + bandH / 2
      : y + inset.n + (h - inset.n - inset.s - leafMarkerBand) / 2;

    if (iconSvg && !caption && !isContainer) {
      // No label and no children: the icon is the whole content, centred in the box.
      const size = iconPx(iconFactor, ICON_SIZE_LARGE);
      svg.appendChild(iconEl(iconSvg, centerX - size / 2, centerY - size / 2, size));
    } else {
      const labelWidth = caption ? ctx.labelWidths.get(node.id as string) ?? 0 : 0;
      const size = iconPx(iconFactor, ICON_SIZE);
      const g = iconLabelContent(iconSvg, size, caption, 'bpmn-label', labelWidth);
      g.setAttribute('transform', `translate(${centerX} ${centerY})`);
      svg.appendChild(g);
    }
  }

  // Regions share out their parent's interior so their fill reaches every border —
  // stepped back 1px so it never paints over the parent's own outline (below the
  // label band, where there is one). This only kicks in when EVERY sibling is a
  // region, so a region never paints over a real neighbour; otherwise it draws at
  // its snug laid-out box. Record each region child's rect before recursing.
  const kids = node.children ?? [];
  const regionKids = kids.filter((k) => ctx.types.get(k.id) === 'region');
  const onlyRegions = kids.length > 0 && regionKids.length === kids.length;
  if (regionKids.length > 0 && onlyRegions) {
    const bandH = ctx.topBandById.get(node.id as string) ?? CONTAINER_LABEL_BAND;
    const band =
      type === 'region'
        ? caption || iconSpec
          ? bandH
          : 0
        : caption || iconSpec
          ? bandH
          : CONTAINER_PAD;
    const interior: Rect = {
      x: box.x + 1,
      y: box.y + band,
      w: box.w - 2,
      h: box.h - band - 1,
    };
    const boxes: Rect[] = regionKids.map((k) => ({
      x: x + (k.x ?? 0),
      y: y + (k.y ?? 0),
      w: k.width ?? 0,
      h: k.height ?? 0,
    }));
    const rects = partitionRegions(interior, boxes, regionsStackVertically(boxes));
    regionKids.forEach((k, i) => ctx.regionRects.set(k.id as string, rects[i]));
  }

  // A pool fits its lanes to its box so they tile it with no gaps. Along the FLOW
  // axis each lane spans the content region past the label band. Along the CROSS
  // axis (where the lanes stack) they must fill the pool's full extent even when
  // ELK left slack — e.g. a boundary-crossing edge can grow the pool a few pixels
  // past its lone lane — so the pool's cross span is distributed across the lanes in
  // order, proportional to their laid-out sizes. The lane's own children still draw
  // from their ELK origin, so only the lane box grows.
  if (type === 'pool' && isContainer) {
    const flow = ctx.flowById.get(node.id as string) ?? 'TB';
    const band = POOL_LABEL_BAND;
    const horizontal = flow === 'LR' || flow === 'RL';
    // The flow-axis span every lane shares. The band sits on the flow's start edge
    // (west for LR, north for TB, …), so it only ever eats into the flow axis.
    const flowStart =
      flow === 'LR' ? box.x + band : flow === 'TB' ? box.y + band : horizontal ? box.x : box.y;
    const flowLen = horizontal ? box.w - band : box.h - band;
    // The cross axis is the pool's full extent (the band never touches it).
    const crossStart = horizontal ? box.y : box.x;
    const crossLen = horizontal ? box.h : box.w;
    const crossOrigin = (k: ElkNode): number => (horizontal ? y + (k.y ?? 0) : x + (k.x ?? 0));
    const crossSize = (k: ElkNode): number => (horizontal ? k.height ?? 0 : k.width ?? 0);
    const lanes = kids
      .filter((k) => ctx.types.get(k.id) === 'lane')
      .sort((a, b) => crossOrigin(a) - crossOrigin(b));
    const totalLaid = lanes.reduce((sum, k) => sum + crossSize(k), 0) || 1;
    let cursor = crossStart;
    for (const lane of lanes) {
      const cLen = (crossSize(lane) / totalLaid) * crossLen;
      const rect: Rect = horizontal
        ? { x: flowStart, y: cursor, w: flowLen, h: cLen }
        : { x: cursor, y: flowStart, w: cLen, h: flowLen };
      ctx.laneRects.set(lane.id as string, rect);
      cursor += cLen;
    }
  }

  for (const child of regionsFirst(kids, ctx.types)) {
    drawNode(svg, child, x, y, ctx);
  }
}

// Every drawn entity gets a `bpmn-<type>` class for variant styling and, when it
// is a container, `bpmn-container`. Everything but a region also shares
// `bpmn-entity`, which carries the common stroke — a region is borderless, so it
// is deliberately left out of that rule.
export function classFor(type: EntityType, isContainer: boolean): string {
  const classes = type === 'region' ? ['bpmn-region'] : ['bpmn-entity', `bpmn-${type}`];
  if (isContainer) classes.push('bpmn-container');
  return classes.join(' ');
}

// Builds the outline element for an entity. A gateway is a diamond; a region is a
// borderless rectangle (transparent unless a `fill` is set); a group is a
// round-cornered rectangle (its dash-dot stroke comes from CSS); pools/lanes and
// containers are plain rectangles. Activities, events, data elements, and text
// annotations draw their own shapes and never reach here. Fill (and an explicit
// stroke, when set) is applied via an inline `style` so it wins over the CSS
// defaults.
export function shapeFor(
  type: EntityType,
  x: number,
  y: number,
  w: number,
  h: number,
  resolved: Resolved | undefined,
  isContainer: boolean,
): SVGElement {
  let inline = `fill:${resolved?.fill ?? 'transparent'}`;
  // A region never renders a border, whatever stroke it might inherit.
  if (type === 'region') inline += ';stroke:none';
  else if (resolved?.strokeExplicit) inline += `;stroke:${resolved.strokeExplicit}`;

  // A gateway is a diamond: the square rotated 45°, i.e. a polygon through the
  // midpoints of its bounding box. It carries the common entity outline like a box.
  if (type === 'gate') {
    const pts = `${x + w / 2},${y} ${x + w},${y + h / 2} ${x + w / 2},${y + h} ${x},${y + h / 2}`;
    return svgEl('polygon', { points: pts, style: inline, class: classFor(type, isContainer) });
  }

  const attrs: Record<string, string | number> = {
    x,
    y,
    width: w,
    height: h,
    style: inline,
    class: classFor(type, isContainer),
  };
  // A group is drawn with rounded corners; every other box is square-cornered.
  if (type === 'group') {
    attrs.rx = GROUP_CORNER;
    attrs.ry = GROUP_CORNER;
  }
  return svgEl('rect', attrs);
}

// ---- gateway edge clipping -------------------------------------------------

// Whether a point sits on the border of a gateway's BOUNDING BOX (which is what ELK
// routed to), within half a pixel of it.
function onGateBorder(p: Pt, g: AbsRect): boolean {
  const e = 0.5;
  const onX =
    (Math.abs(p.x - g.x) < e || Math.abs(p.x - (g.x + g.w)) < e) &&
    p.y >= g.y - e &&
    p.y <= g.y + g.h + e;
  const onY =
    (Math.abs(p.y - g.y) < e || Math.abs(p.y - (g.y + g.h)) < e) &&
    p.x >= g.x - e &&
    p.x <= g.x + g.w + e;
  return onX || onY;
}

// Pulls a point on the bounding box in to the inscribed diamond's edge, keeping the
// axis its terminal segment runs along fixed so the line stays orthogonal.
function clipToDiamond(p: Pt, neighbor: Pt, g: AbsRect): Pt {
  const cx = g.x + g.w / 2;
  const cy = g.y + g.h / 2;
  const rx = g.w / 2;
  const ry = g.h / 2;
  // The diamond edge satisfies |x-cx|/rx + |y-cy|/ry = 1. Keep the axis the
  // terminal segment runs along fixed and solve for the other.
  if (Math.abs(p.y - neighbor.y) < 0.5) {
    const t = 1 - Math.abs(p.y - cy) / ry;
    return t <= 0 ? p : { x: p.x >= cx ? cx + rx * t : cx - rx * t, y: p.y };
  }
  if (Math.abs(p.x - neighbor.x) < 0.5) {
    const t = 1 - Math.abs(p.x - cx) / rx;
    return t <= 0 ? p : { x: p.x, y: p.y >= cy ? cy + ry * t : cy - ry * t };
  }
  return p;
}

// The `ClipEnds` hook for a BPMN diagram: a gateway is laid out as a square box but
// DRAWN as the diamond inscribed in it, so an edge end ELK put on the box border
// would float in the corner gap. Pull both ends in to the diamond's edge. Mutates
// the point list in place; a diagram with no gateways is a no-op.
export function gateClipper(gates: AbsRect[]): (points: Pt[]) => void {
  return (points: Pt[]): void => {
    if (points.length < 2 || gates.length === 0) return;
    const clip = (i: number, j: number): void => {
      const g = gates.find((g) => onGateBorder(points[i], g));
      if (g) points[i] = clipToDiamond(points[i], points[j], g);
    };
    clip(0, 1);
    clip(points.length - 1, points.length - 2);
  };
}
