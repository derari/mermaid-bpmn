import ELK, { type ElkNode } from 'elkjs/lib/elk.bundled.js';
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
  db,
  entityLabel,
} from './db.js';
import { resolveBoundaryAutoSides } from './boundarySides.js';
import { type PortValidation, analysePorts } from './portTypes.js';
import {
  type Rect,
  commonAncestorId,
  partitionRegions,
  regionsStackVertically,
} from './geometry.js';
import {
  type Anchor,
  type ArrowEnd,
  type ChainPlan,
  type JoinPlan,
  OPPOSITE,
  type PortSpec,
  planRoute,
  resolveEnterSide,
  resolveExitSide,
  subtreeDirectionsUniform,
} from './routePlan.js';
import { type Resolved, resolveStyles } from './styleModel.js';
import { type IconSvg, resolveIcons } from './icons.js';
import { renderTheme } from './theme.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

// The entity families this renderer draws. Any family NOT listed here is skipped
// entirely — dropped from the ELK graph together with its subtree — and lines to a
// skipped entity resolve to nothing and are warned+dropped like any other unknown
// endpoint. `region` and `port` are structural (a transparent grouping box and an
// edge anchor) and always kept.
const SUPPORTED_TYPES: ReadonlySet<EntityType> = new Set<EntityType>([
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
const LEAF_MIN_W = 80;
const LEAF_H = 44;
// An activity's minimum box is 50% larger than the generic leaf minimum, so tasks
// read as the primary shape; every other family (pools, gateways, events) keeps
// the base size.
const ACTIVITY_MIN_W = LEAF_MIN_W * 1.5; // 120
const ACTIVITY_MIN_H = LEAF_H * 1.5; // 66
const LABEL_PAD_X = 20; // horizontal breathing room around a leaf label
const CONTAINER_LABEL_BAND = 30; // top padding reserved for a container's label
const CONTAINER_PAD = 12; // left/right/bottom padding inside a container
const GROUP_CORNER = 10; // corner radius of a group's round-cornered box
const NODE_SPACING = 24; // gap between sibling boxes

// Connection lines draw as rounded <path>s: each interior corner is rounded with
// LINE_CORNER_RADIUS (clamped per corner so tight corners can't overshoot), and a
// narrow S-bend — a short perpendicular jog joining two same-direction runs — is
// turned into a smooth diagonal "lane change" instead of a double-kink.
// DIAGONAL_MIN_ANGLE is the shallowest such diagonal allowed (a flatter ramp would
// read as a wobble, so setbacks scale down to hold this angle).
const LINE_CORNER_RADIUS = 10;
const DIAGONAL_MIN_ANGLE = (20 * Math.PI) / 180;

// A line-end slash tick (from a leading/trailing `/` connector — BPMN's
// default-sequence-flow marker). SLASH_LEN is its drawn length; SLASH_INSET how
// far along the line from the endpoint its centre sits, so it crosses the visible
// line just inside the node rather than at the very tip (under an arrowhead).
const SLASH_LEN = 11;
const SLASH_INSET = 9;

// A hand-placed line caption (only on a single-bridge line ELK can't label): how
// far along the first run from the source its centre sits, and its gap off the line.
const EDGE_LABEL_INSET = 8;
const EDGE_LABEL_GAP = 5;

// An activity is drawn as a slightly rounded rectangle (BPMN task shape). Its
// activity type refines that outline: a `call` activity gets a bold (double
// width) border; an `event-subprocess` a dotted one; a `transaction` a double
// outline drawn with thinner lines (an inner rounded rect inset from the outer).
// `task` and `subprocess` keep the plain single outline.
const ACTIVITY_RADIUS = 6;
const ACTIVITY_STROKE = 1.5; // the default entity stroke width (see styles.ts)
const ACTIVITY_THICK = ACTIVITY_STROKE * 2; // a call activity's bold border
const ACTIVITY_DOTTED = '1.5 3'; // an event-subprocess's dotted outline
const ACTIVITY_DOUBLE_GAP = 4; // a transaction's inner-outline inset
const ACTIVITY_DOUBLE_STROKE = 1; // a transaction's thinner double lines

// BPMN activity markers sit in a row centred along the box's bottom edge: the
// collapsed-composite `+`, and the loop / multi-instance marker. A box that
// carries any reserves a MARKER_BAND-tall strip at its bottom so the marker row
// does not collide with the centred caption above it.
const MARKER_SIZE = 16; // one marker glyph
const MARKER_GAP = 3; // spacing between markers in the row
const MARKER_BAND = MARKER_SIZE + 6; // bottom strip reserved for the marker row

// An empty pool (no lanes) is a fixed sharp-cornered box: eight activity widths
// across, two activity heights tall, with its label centred.
const POOL_MIN_W = LEAF_MIN_W * 8;
const POOL_MIN_H = LEAF_H * 2;

// A gateway is a diamond (a square rotated 45°) with a type marker drawn inside.
// GATE_SIZE is its bounding box; GATE_ICON the marker's size, kept small enough to
// sit inside the diamond's inscribed square.
const GATE_SIZE = 48;
const GATE_ICON = 24;

// An event is a circle with a type marker inside. Its outline style (thin/thick/
// double/dashed) comes from the event operation; the marker from the event type.
const EVENT_SIZE = 44;
const EVENT_ICON = 26; // the marker fills most of the circle (~22px of glyph)
const EVENT_DOUBLE_GAP = 3; // ring spacing for intermediate/boundary (double) events
const EVENT_THICK = 4.5; // stroke width for an end event's bold ring
const EVENT_DASH = '4.5 3'; // dash/gap for a non-interrupting (dashed) ring (was 3 2, +50%)

// A data element is a fixed box, taller than wide (4:5), with its caption centred
// inside. A data OBJECT is a rectangle with its top-right corner folded (a
// dog-ear); a data STORE is a cylinder with a lid. DATA_FOLD is the dog-ear's leg
// length; DATA_LID_RY the half-height of the cylinder's top/bottom ellipses.
const DATA_W = 72;
const DATA_H = 90; // 4:5, taller than wide
const DATA_FOLD = 21;
const DATA_LID_RY = 10.5;
// The `collection` marker: three vertical bars centred along the data object's
// bottom edge. GAP is the clearance from the bottom, BAR_GAP the spacing between
// bars (also their offset from centre for the outer two).
const DATA_COLLECTION_BAR_H = 16;
const DATA_COLLECTION_GAP = 6;
const DATA_COLLECTION_BAR_GAP = 6;

// A caption may span several lines (a `\n` escape, or a `|` multi-line label). Each
// line is drawn on its own row and reserved this much vertical room; a box grows
// taller for extra lines so a multi-line caption is never clipped.
const LABEL_LINE_H = 16;

// Gateways and events draw their caption OUTSIDE the shape — below it in a
// horizontal flow, to its right in a vertical one — reserved as an ELK OUTSIDE
// node label.
const OUTSIDE_LABEL_LINE_H = LABEL_LINE_H; // reserved height per outside caption line
const OUTSIDE_LABEL_GAP = 6; // spacing between the shape and its outside caption

// A text annotation (`comment`) is a transparent box with an open, bold bracket
// drawn on ONE edge — the BPMN text-annotation cue. The bracket runs the full edge
// with a short cap turning in at each end; `TEXT_BRACKET_CAP` is that cap's length
// (clamped to a third of the box so the caps never meet), `TEXT_BRACKET_STROKE` its
// bold width.
const TEXT_BRACKET_CAP = 12;
const TEXT_BRACKET_STROKE = 2;

// Under the `debug ports` overlay, every hand-routed (manual) line is forced to
// this blue so it stands out from the ELK-routed lines (which keep their theme
// color) — matching the red/green port squares the same overlay draws.
const DEBUG_MANUAL_STROKE = '#2962ff';

// Icons (see icons.ts). An inline icon is drawn at one line height, before the
// label; a box with neither label nor children draws its icon alone at twice that
// (an icon-only glyph). `ICON_GAP` sits between an inline icon and its label.
const ICON_SIZE = 18; // one line height — the inline icon size
const ICON_SIZE_LARGE = ICON_SIZE * 2; // the label-less, childless box's big icon
const ICON_GAP = 6;

const elk = new ELK();

// Maps our direction vocabulary onto ELK's.
const ELK_DIRECTION: Record<Direction, string> = {
  TB: 'DOWN',
  BT: 'UP',
  LR: 'RIGHT',
  RL: 'LEFT',
};

// Maps a compass side onto ELK's port-side vocabulary.
const ELK_PORT_SIDE: Record<Side, string> = {
  n: 'NORTH',
  e: 'EAST',
  s: 'SOUTH',
  w: 'WEST',
};

// The side a boundary event pins to under `auto` (the default): 90° clockwise from
// the host activity's layout direction. With LR flow the event drops to the SOUTH
// edge (the BPMN convention), TB flow sends it WEST, and so on for the reverse
// directions. An explicit compass side overrides this.
const ROTATE_CW_90: Record<Direction, Side> = { LR: 's', TB: 'w', RL: 'n', BT: 'e' };

// Toggles a direction to its perpendicular axis while PRESERVING the sign:
// TB↔LR and BT↔RL. A pool — and the diagram root when it holds pools — stacks its
// children ACROSS the flow, so its ELK layout direction is the toggled flow: a
// horizontal (LR) pool stacks its lanes top-to-bottom (TB); a reversed vertical
// (BT) pool stacks them right-to-left (RL); and so on. This is purely a layout
// concern — the children still inherit the un-toggled flow.
const TOGGLE_AXIS: Record<Direction, Direction> = { TB: 'LR', LR: 'TB', BT: 'RL', RL: 'BT' };

// The edge a pool/lane label band sits on — the start of the flow: LR→west,
// RL→east, TB→north, BT→south.
const BAND_SIDE: Record<Direction, Side> = { LR: 'w', RL: 'e', TB: 'n', BT: 's' };

// The label rotation (SVG degrees, clockwise) inside that band. A west band reads
// bottom-to-top (−90); an east band top-to-bottom (90); a top/bottom band stays
// horizontal.
const LABEL_ROT: Record<Direction, number> = { LR: -90, RL: 90, TB: 0, BT: 180 };

// The thickness of a pool/lane label band (its short dimension). The label runs
// along the band's long axis.
const POOL_LABEL_BAND = CONTAINER_LABEL_BAND;

// A port never draws a caption; everything else (activity, region heading) draws
// its caption INSIDE the box — centred in a leaf, or in the top label band of a
// container. Whether a caption exists at all is decided per entity by
// `entityLabel`; this only says whether a present caption is drawn here.
function drawsInternalLabel(type: EntityType): boolean {
  return type !== 'port';
}

// Every drawn family may carry an `icon:` — i.e. everything but `port`, which
// draws nothing at all.
function canHaveIcon(type: EntityType): boolean {
  return type !== 'port';
}

// The bpmn-pack icon specs for the markers drawn in an activity's bottom row,
// in draw order. A loop or multi-instance activity gets its loop/bar marker first;
// a `collapsed` expandable activity (a subprocess/call-subprocess/event-subprocess/
// transaction drawn without its children) gets the composite `+` LAST. These are independent of
// the task-type glyph (which is drawn with the caption). The `compensation` marker
// reuses the bpmn `compensation-in` glyph.
function activityMarkerSpecs(entity: Entity, collapsed: boolean): string[] {
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
function iconPx(factor: number | undefined, auto: number): number {
  return factor && factor > 0 ? factor * ICON_SIZE : auto;
}

function svgEl<K extends keyof SVGElementTagNameMap>(
  name: K,
  attrs: Record<string, string | number>,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) {
    node.setAttribute(key, String(value));
  }
  return node;
}

// Measures rendered label width using a throwaway <text> in the target svg, so
// box sizing matches the actual font/metrics the browser will use. The caller
// must invoke the returned `done()` to remove the probe once measuring is over.
function makeMeasurer(svg: SVGSVGElement): {
  measure: (text: string) => number;
  done: () => void;
} {
  const probe = svgEl('text', { class: 'bpmn-label', x: -9999, y: -9999 });
  svg.appendChild(probe);
  return {
    measure(text: string) {
      probe.textContent = text;
      return probe.getComputedTextLength();
    },
    done() {
      probe.remove();
    },
  };
}

// A caption's laid-out size. A caption may contain `\n`s (from a `\n` escape or a
// `|` multi-line label): each becomes its own line, the box width is the WIDEST
// line, and the height reserves one `LABEL_LINE_H` per line. `lines` is kept so the
// draw pass renders the same rows the size was computed from.
interface LabelMetrics {
  width: number;
  height: number;
  lines: string[];
}
function measureLabel(caption: string, measure: (text: string) => number): LabelMetrics {
  const lines = caption.split('\n');
  let width = 0;
  for (const line of lines) width = Math.max(width, measure(line));
  return { width, height: lines.length * LABEL_LINE_H, lines };
}

// Build-time indexes threaded through the recursive node build. Beyond sizing
// each node they record the maps the connection pass needs: entity -> node id
// (and its inverse for the draw pass), a first-wins name lookup for resolving
// absolute-line endpoints, and per-container direction.
interface BuildCtx {
  measure: (text: string) => number;
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
  // id. The connection pass reads it to decide whether flattening a subtree with
  // INCLUDE_CHILDREN would clobber a differing direction.
  dirById: Map<string, Direction>;
  // The FLOW direction of each pool/lane, by node id — which may differ from the
  // ELK layout direction (a pool stacks lanes perpendicular to its flow). The draw
  // pass reads it to place and rotate the label band.
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
  // Declared `port` entities, resolved to the ELK port they became: its id, the
  // container node it hangs off, and the edge it pins to. A line whose endpoint is
  // a port connects to `portId` (the edge lives in the LCA of the two containers).
  ports: Map<Entity, { portId: string; containerId: string; side: Side }>;
  // Every declared port's id, so the debug overlay can tint them apart from the
  // (red) routing ports.
  declaredPortIds: Set<string>;
  // The root-only `debug ports` overlay flag. The connection pass reads it to
  // force hand-routed lines blue (see applyManualRoute).
  debugPorts: boolean;
  // Boundary events attached to an activity, by the ELK port id they became. The
  // draw pass reads this to draw the event circle (its glyph, its dashed/double
  // ring) centred on the host's border at the port's laid-out position, and to
  // place its caption on the outward side.
  boundaryEvents: Map<
    string,
    {
      op: EventOperation | undefined;
      resolved: Resolved | undefined;
      caption: string;
      // The border point in the port's local coords (see elk.port.anchor): the
      // circle is drawn centred here, over the reserved label room.
      anchor: { ax: number; ay: number };
      // The caption box relative to the circle centre; null when uncaptioned. The
      // draw pass positions the text from it (see boundaryLabelBox).
      labelBox: LabelBox | null;
    }
  >;
  // The smart side chosen for each `auto`/omitted boundary event (facing its
  // exception target's branch); absent when no clear side was found, in which case
  // the 90°-cw default applies. See resolveBoundaryAutoSides.
  boundaryAutoSide: Map<Entity, Side>;
  // Every entity referenced by at least one line, so a boundary event can tell
  // whether it has a line (and thus must move its caption clear of it).
  lineEntities: Set<Entity>;
  // Per host node id, the interior clearance reserved on each side carrying a
  // boundary event (see BoundaryInset). Read when sizing/padding the host and when
  // placing its caption and markers, so nothing lands under a boundary circle.
  boundaryInsetById: Map<string, BoundaryInset>;
}

// One zero-size ELK port, pinned to a side. Shared by declared ports (below) and
// the router's own ports (see applyManualRoute).
interface ElkPortSpec {
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
function isBoundaryPortChild(parent: Entity, child: Entity): boolean {
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
interface LabelBox {
  left: number;
  right: number;
  top: number;
  bottom: number;
}
function boundaryLabelBox(
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
function boundaryPortExtents(
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
interface BoundaryInset {
  n: number;
  e: number;
  s: number;
  w: number;
}
const NO_INSET: BoundaryInset = { n: 0, e: 0, s: 0, w: 0 };

// Builds the ELK border ports for an entity's port-like children — zero-size
// anchors for declared `port`s, and EVENT_SIZE anchors straddling the border for
// boundary events attached to an activity. Both are pinned (FIXED_SIDE, see
// attachPorts) and registered in ctx so lines can resolve to them. Shared by the
// leaf and container branches of toElkNode, so an entity whose ONLY children are
// such ports still gets them — and is built as a leaf box rather than an empty
// compound node (which ELK collapses to zero size). The declaration index is kept
// in the port id so ordering stays stable across mixed port/box children. `flow`
// is the host's layout direction, used to resolve a boundary event's `auto` side.
function declaredPorts(entity: Entity, id: string, ctx: BuildCtx, flow: Direction): ElkPortSpec[] {
  const ports: ElkPortSpec[] = [];
  const inset: BoundaryInset = { n: 0, e: 0, s: 0, w: 0 };
  entity.children.forEach((child, i) => {
    const portId = `${id}.port${i}`;
    if (child.type === 'port') {
      const side = child.portSide ?? 'n';
      ports.push({ id: portId, width: 0, height: 0, layoutOptions: { 'elk.port.side': ELK_PORT_SIDE[side] } });
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
      const lm = caption ? measureLabel(caption, ctx.measure) : null;
      const labelBox = lm
        ? boundaryLabelBox(side, ctx.lineEntities.has(child), lm.width, lm.height)
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
function attachPorts(node: ElkNode, ports: ElkPortSpec[]): void {
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
function toElkNode(
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
  if (caption) ctx.labelWidths.set(id, measureLabel(caption, ctx.measure).width);

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
  const hasBoxChildren = entity.children.some(isBoxChild);

  // The activity's bottom marker row (if any). An activity with no box children is
  // "collapsed" (drawn as a leaf), which is what a composite `+` marker keys off.
  const markerSpecs =
    entity.type === 'activity' ? activityMarkerSpecs(entity, !hasBoxChildren) : [];
  if (markerSpecs.length > 0) ctx.markerSpecsById.set(id, markerSpecs);
  const hasMarkers = markerSpecs.length > 0;

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
    const elkDir = entity.type === 'pool' ? TOGGLE_AXIS[flow] : flow;
    ctx.dirById.set(id, elkDir);
    const children: ElkNode[] = [];
    entity.children.forEach((child, i) => {
      if (!isBoxChild(child)) return;
      children.push(toElkNode(child, `${id}.${i}`, flow, ctx, false));
    });
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
    // Every supported non-port child becomes a child node (ports were built
    // above; unsupported families are skipped). The declaration index is kept in
    // the node id even across skipped children, so branch ordering stays stable.
    const children: ElkNode[] = [];
    entity.children.forEach((child, i) => {
      if (!isBoxChild(child)) return;
      children.push(toElkNode(child, `${id}.${i}`, direction, ctx, false));
    });
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
    const captionLines = caption ? caption.split('\n').length : 1;
    const bandCaptionH = CONTAINER_LABEL_BAND + (captionLines - 1) * LABEL_LINE_H;
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
interface LeafLabel {
  text: string;
  width?: number;
  height?: number;
  layoutOptions?: Record<string, string>;
}
interface LeafSize {
  width: number;
  height: number;
  labels?: LeafLabel[];
  layoutOptions?: Record<string, string>;
}

// The ELK label spec for a caption drawn OUTSIDE a gateway/event shape — below it
// in a horizontal flow, to its right in a vertical one. ELK reserves the room and
// positions the label; the draw pass reads the laid-out box back (see drawNode).
function outsideLabel(
  caption: string,
  measure: (text: string) => number,
  flow: Direction,
): Pick<LeafSize, 'labels' | 'layoutOptions'> {
  if (!caption) return {};
  const horizontal = flow === 'LR' || flow === 'RL';
  const placement = horizontal ? 'OUTSIDE H_CENTER V_BOTTOM' : 'OUTSIDE H_RIGHT V_CENTER';
  const m = measureLabel(caption, measure);
  return {
    labels: [
      {
        text: caption,
        width: m.width,
        height: m.height,
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
function leafSize(
  entity: Entity,
  measure: (text: string) => number,
  flow: Direction,
  icon?: string,
  iconFactor?: number,
  hasMarkers = false,
): LeafSize {
  const caption = entityLabel(entity);
  const label = measureLabel(caption, measure);
  // Every extra caption line past the first adds one line height to the box, so a
  // multi-line caption is reserved room and never clipped.
  const extraLinesH = (label.lines.length - 1) * LABEL_LINE_H;
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
    const width = Math.max(DATA_W, label.width + LABEL_PAD_X);
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
    const labelLen = entity.type === 'lane' && caption ? label.width + LABEL_PAD_X : 0;
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
    width: Math.max(minW, label.width + LABEL_PAD_X * 2 + iconExtra),
    height: Math.max(minH + extraLinesH, size ? size + LABEL_PAD_X : 0) + markerBand,
    labels: [{ text: caption }],
  };
}

function containerOptions(
  direction: Direction,
  topPad: number,
  sidePad: number = CONTAINER_PAD,
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
  };
}

function padding(top: number, left: number, bottom: number, right: number): string {
  return `[top=${top},left=${left},bottom=${bottom},right=${right}]`;
}

// Layout options for a pool or lane: `elkDir` is how ELK stacks the children
// (perpendicular to the flow for a pool, along it for a lane); `flow` fixes which
// edge reserves the label band; `innerPad` is the padding on the other three
// sides, and `spacing` the gap between children (0 for a pool's flush lanes).
function poolLaneOptions(
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

// Invisible edges A->B->C to force reading order along the flow direction.
function chainEdges(prefix: string, children: ElkNode[]) {
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

// How to draw a resolved connection: its arrowhead end, whether it is invalid
// (drawn bold red), and its resolved stroke color (undefined = fall back to the
// theme line color via CSS).
//
// A `messageFlow` connection crosses pool boundaries (a BPMN message flow): it is
// drawn dashed, with a hollow (background-filled, stroke-outlined) arrowhead and a
// small open circle at its ORIGIN end. `circle` marks which end of THIS drawn edge
// carries that origin circle (a single edge, or the one manual segment that touches
// the origin) — undefined on every other edge/segment of the line.
//
// A `dataAssoc` connection touches a data element (a BPMN data association): it is
// drawn dotted, with an open (line-only) "V" arrowhead. It takes priority over
// `messageFlow`, so the two are never both set.
interface ConnStyle {
  arrow: ArrowEnd;
  invalid: boolean;
  stroke?: string;
  messageFlow?: boolean;
  dataAssoc?: boolean;
  circle?: 'start' | 'end';
  // A slash tick drawn at this drawn edge's start point and/or end point (from a
  // leading/trailing `/` on the connector — the BPMN default-flow marker). A
  // polyline is drawn source-point-first, so on a whole-line edge `slashStart`
  // is the source end and `slashEnd` the target end; a manual route redistributes
  // them onto the segment that touches each end (see applyManualRoute).
  slashStart?: boolean;
  slashEnd?: boolean;
}

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

// A drawn ELK edge, as this pass builds it before layout. Kept minimal — ELK
// fills in sections/label boxes — but wide enough to attach a label and options.
interface DrawnEdge {
  id: string;
  sources: string[];
  targets: string[];
  labels?: { id: string; text: string; width: number; height: number }[];
  layoutOptions?: Record<string, string>;
}

// Attaches a line's caption to its ELK edge as an edge label, sized from the
// measured text and placed near the TAIL (source) end so it reads closer to the
// source than the target. ELK reserves the room and positions the box; the draw
// pass reads it back (see drawEdges). Called on whichever segment touches the
// source, so a multi-segment (boundary-crossing) line labels its source side.
function applyEdgeLabel(
  edge: DrawnEdge,
  text: string,
  measure: (t: string) => number,
): void {
  const m = measureLabel(text, measure);
  edge.labels = [{ id: `${edge.id}L`, text, width: m.width, height: m.height }];
  (edge.layoutOptions ??= {})['org.eclipse.elk.edgeLabels.placement'] = 'TAIL';
}

// The hand-drawn bridge for a boundary-crossing line whose LCA mixes directions,
// when the port chains (see planRoute) stop short of a common parent. It connects
// the two outermost anchors — `from` on the source side, `to` on the target side.
interface ManualEdge {
  from: Anchor;
  to: Anchor;
  style: ConnStyle;
  bend?: 'z' | 'n' | 'l' | 'auto';
  exitSide?: Side;
  enterSide?: Side;
  // A line caption drawn near the source, only when the whole line is a single
  // hand-drawn bridge (no ELK edge to hang an ELK label on). Pre-measured.
  label?: { text: string; width: number; height: number };
}

// What the connection pass hands back: how to draw each ELK-routed edge (keyed
// by edge id), the set of node ids that ended up with at least one such edge,
// the containers that should flatten via INCLUDE_CHILDREN, and the edges we must
// route ourselves (see ManualEdge).
interface Connections {
  styles: Map<string, ConnStyle>;
  connected: Set<string>;
  hierarchyContainers: Set<ElkNode>;
  manualEdges: ManualEdge[];
}

// One resolved line endpoint. `elk` is what an ELK edge attaches to (a node id, or
// a port id for a declared port); `owner` is the node id that governs the edge's
// LCA (the node itself, or a port's container).
interface EndpointRef {
  elk: string;
  owner: string;
  isPort: boolean;
  entity: Entity;
  // The border side a fixed port sits on (declared `port` or a pool port). The
  // bridge must attach along this edge's axis, so it overrides the auto exit/enter
  // side when this endpoint is fixed. Undefined for a plain (non-port) endpoint.
  portSide?: Side;
}

// Resolves a line endpoint entity to its ELK/owner ids, or null when it is
// unknown (undefined entity) or was never built into a node (e.g. a skipped,
// unsupported entity). A declared port resolves to its ELK port; anything else to
// its node.
function resolveEndpoint(entity: Entity | undefined, ctx: BuildCtx): EndpointRef | null {
  if (!entity) return null;
  const port = ctx.ports.get(entity);
  if (port) {
    return { elk: port.portId, owner: port.containerId, isPort: true, entity, portSide: port.side };
  }
  const id = ctx.idOf.get(entity);
  if (!id) return null;
  return { elk: id, owner: id, isPort: false, entity };
}

// The id of the pool a node sits in — the nearest ancestor of type `pool` (or the
// node itself when it is one), or undefined when it sits in no pool. Node ids are
// dot-paths, so ancestors are just prefixes. Used to tell a message flow (crossing
// pools) from an ordinary sequence flow.
function poolOf(id: string, ctx: BuildCtx): string | undefined {
  const parts = id.split('.');
  for (let i = parts.length; i >= 1; i--) {
    const prefix = parts.slice(0, i).join('.');
    if (ctx.types.get(prefix) === 'pool') return prefix;
  }
  return undefined;
}

// Turns each line into a real ELK edge. An edge must live in the lowest common
// ancestor of its endpoints (ELK's rule for hierarchical edges), which the
// dot-path ids make a cheap prefix computation. Endpoints that resolve to the
// same node, or to no node at all, are dropped with a warning so one bad
// reference never sinks the whole render.
function addConnections(
  graph: ElkNode,
  lines: Line[],
  ctx: BuildCtx,
  resolved: Map<Entity, Resolved>,
  diagramDirection: Direction,
  validation: PortValidation,
): Connections {
  const styles = new Map<string, ConnStyle>();
  const connected = new Set<string>();
  const hierarchyContainers = new Set<ElkNode>();
  const manualEdges: ManualEdge[] = [];
  lines.forEach((line, i) => {
    const sourceEntity =
      typeof line.source === 'string' ? ctx.byName.get(line.source) : line.source;
    const targetEntity =
      typeof line.target === 'string' ? ctx.byName.get(line.target) : line.target;
    const source = resolveEndpoint(sourceEntity, ctx);
    const target = resolveEndpoint(targetEntity, ctx);
    if (!source || !target || source.elk === target.elk) {
      console.warn(`bpmn: could not draw connection ${describeLine(line)}`);
      return;
    }

    const lca = commonAncestorId(source.owner, target.owner);
    const container = lca === '' ? graph : ctx.nodeById.get(lca);
    if (!container) return;

    // Validity spans the whole graph for ports (an arrowhead may not land on one),
    // so it is decided once by the port analyser.
    const invalid = validation.isInvalidLine(line);
    const id = `conn${i}`;
    // A line touching a data element or a text annotation is a data association:
    // dotted, with an open (line-only) arrowhead. This takes priority over the
    // message-flow look. The owner (not the endpoint entity) is tested so a line
    // routed THROUGH a declared port still counts — a port's owner is the container
    // it sits on, so a port inside a text/data annotation resolves to it.
    const touchesAnnotation = (ref: EndpointRef): boolean => {
      const t = ctx.types.get(ref.owner);
      return t === 'data' || t === 'text';
    };
    const dataAssoc = !invalid && (touchesAnnotation(source) || touchesAnnotation(target));
    // A message flow crosses pool boundaries: its endpoints sit in different pools
    // (or one in none). Data associations are excluded (handled above), so a data
    // line keeps the dotted look even across pools.
    const messageFlow =
      !invalid &&
      !dataAssoc &&
      poolOf(source.owner, ctx) !== poolOf(target.owner, ctx);
    const style: ConnStyle = {
      arrow: arrowFor(line.type),
      invalid,
      stroke: invalid ? undefined : lineStroke(line, lca, ctx, resolved),
      messageFlow,
      dataAssoc,
      // A leading `/` marks the source (start) end, a trailing `/` the target
      // (end) end. On a plain/flatten edge (drawn source → target) these land
      // directly; a manual route redistributes them per segment below.
      slashStart: line.slash === 'start' || line.slash === 'both',
      slashEnd: line.slash === 'end' || line.slash === 'both',
    };
    // For a single (plain/flatten) edge the path runs source → target, so the
    // origin circle sits opposite the arrowhead: at the start for --> / ---, at the
    // end for <--. A manual route recomputes this per segment (see applyManualRoute).
    if (messageFlow) style.circle = style.arrow === 'start' ? 'end' : 'start';

    // The exit/enter sides the routing would use, computed once from the same pure
    // helpers planRoute uses — needed here to place pool ports (below) on the side
    // that faces the other endpoint.
    const lcaDir = lca === '' ? diagramDirection : ctx.dirById.get(lca) ?? diagramDirection;
    const exitSide = resolveExitSide(line.routing?.exit, source.owner, target.owner, lca, lcaDir);
    const enterSide = resolveEnterSide(line.routing?.enter, exitSide);

    // A line that attaches directly to a pool box gets its OWN port on that pool,
    // so ELK spreads several lines around the pool's boundary instead of stacking
    // them at one attachment point. The port is pinned to the side FACING the other
    // endpoint (its exit/enter side) but its POSITION on that side is left to ELK
    // (FIXED_SIDE), so multiple lines land at distinct points along the right edge.
    // The endpoint then behaves like a fixed anchor for routing (the other side
    // chains to meet it). A declared `port` endpoint already has its own anchor and
    // is left untouched.
    const poolPortEndpoint = (ref: EndpointRef, suffix: string, side: Side): EndpointRef => {
      if (ref.isPort || ctx.types.get(ref.elk) !== 'pool') return ref;
      const pool = ctx.nodeById.get(ref.elk);
      if (!pool) return ref;
      const portId = `${id}${suffix}pool`;
      (pool.ports ??= []).push({
        id: portId,
        width: 0,
        height: 0,
        layoutOptions: { 'elk.port.side': ELK_PORT_SIDE[side] },
      });
      (pool.layoutOptions ??= {})['elk.portConstraints'] = 'FIXED_SIDE';
      return { ...ref, elk: portId, isPort: true, portSide: side };
    };
    const srcRef = poolPortEndpoint(source, 's', exitSide);
    const tgtRef = poolPortEndpoint(target, 't', enterSide);
    const sourceId = srcRef.elk;
    const targetId = tgtRef.elk;

    // Classify the line (plain sibling edge / flatten via INCLUDE_CHILDREN /
    // hand-routed port chains) — all the decision logic lives in planRoute, which
    // only needs whether the LCA subtree is direction-uniform. See docs/routing.md.
    const uniform = subtreeDirectionsUniform(container, lcaDir, ctx.dirById);
    const plan = planRoute({
      sourceId,
      targetId,
      sourceOwner: srcRef.owner,
      targetOwner: tgtRef.owner,
      sourceFixed: srcRef.isPort,
      targetFixed: tgtRef.isPort,
      sourcePortSide: srcRef.portSide,
      targetPortSide: tgtRef.portSide,
      lca,
      lcaDir,
      lineType: line.type,
      routing: line.routing,
      uniform,
      connId: id,
    });

    if (plan.kind === 'manual') {
      applyManualRoute(plan, style, ctx, container, styles, manualEdges, line.label);
      return;
    }

    if (plan.kind === 'plain' && plan.warnRoute) {
      console.warn(`bpmn: route on ${describeLine(line)} does nothing (it crosses no boundary)`);
    }
    if (plan.kind === 'flatten') hierarchyContainers.add(container);

    // A single (plain/flatten) edge runs source → target, so its own label sits at
    // the source end (placement TAIL). ELK reserves room and positions it.
    const edge: DrawnEdge = { id, sources: [sourceId], targets: [targetId] };
    if (line.label !== undefined) applyEdgeLabel(edge, line.label, ctx.measure);
    (container.edges ??= []).push(edge);
    styles.set(id, style);
    connected.add(sourceId);
    connected.add(targetId);
  });
  return { styles, connected, hierarchyContainers, manualEdges };
}

// Applies a `manual` RoutePlan to the ELK graph: creates each planned port on its
// container, adds each planned segment as an ELK edge in its container with the
// planned arrowhead, then either adds the ELK join edge in the LCA or records the
// hand-drawn bridge. All the decisions were made by planRoute — this only mutates.
function applyManualRoute(
  plan: { source: ChainPlan; target: ChainPlan; join: JoinPlan },
  style: ConnStyle,
  ctx: BuildCtx,
  lcaContainer: ElkNode,
  styles: Map<string, ConnStyle>,
  manualEdges: ManualEdge[],
  label?: string,
): void {
  // The stroke every piece of this hand-routed line draws with. Normally the
  // line's own stroke, but under the `debug ports` overlay it is forced blue so
  // manual routes stand out from the ELK-routed lines.
  const stroke = ctx.debugPorts ? DEBUG_MANUAL_STROKE : style.stroke;

  const addPort = (p: PortSpec): void => {
    const container = ctx.nodeById.get(p.containerId);
    if (!container) return;
    (container.ports ??= []).push({
      id: p.portId,
      width: 0,
      height: 0,
      layoutOptions: { 'elk.port.side': ELK_PORT_SIDE[p.side] },
    });
    (container.layoutOptions ??= {})['elk.portConstraints'] = 'FIXED_SIDE';
  };
  // A message flow's origin circle sits at the line's source (for --> / ---) or its
  // target (for <--). That endpoint is touched by the first segment of its chain
  // (endpoint → port, so the segment's START), or — when that side grew no chain —
  // by the join: source at the join's start, target at its end. Resolve which
  // segment/join carries the circle, and on which end, so exactly one gets it.
  const originIsSource = style.arrow !== 'start'; // 'start' arrow ⇒ <-- ⇒ origin = target
  const originChain = originIsSource ? plan.source : plan.target;
  const originTouch = originChain.segments[0];
  const circleSegId = style.messageFlow && originTouch ? originTouch.id : undefined;
  const circleOnJoin = style.messageFlow && !originTouch;
  const joinCircle: 'start' | 'end' | undefined = circleOnJoin
    ? originIsSource
      ? 'start'
      : 'end'
    : undefined;

  // The slash ticks are placed like the origin circle, but independently per end.
  // A source-end slash sits at the source endpoint — the START of the source
  // chain's first segment, or the join's start when that side grew no chain. A
  // target-end slash sits at the target endpoint — the START of the target chain's
  // first segment (a chain's touch segment runs endpoint → port), or the join's
  // end. Both touch segments start AT their endpoint, so a slash there is a start.
  const srcTouch = plan.source.segments[0];
  const tgtTouch = plan.target.segments[0];
  const srcSlashSegId = style.slashStart && srcTouch ? srcTouch.id : undefined;
  const tgtSlashSegId = style.slashEnd && tgtTouch ? tgtTouch.id : undefined;
  const joinSlashStart = !!style.slashStart && !srcTouch;
  const joinSlashEnd = !!style.slashEnd && !tgtTouch;

  // The label rides on whichever ELK edge is nearest the source: the source
  // chain's touch segment, else the ELK join, else the target chain's — so it
  // stays close to the source. When the whole line is a single bridge (no ELK
  // edge at all), it is drawn by hand near the source instead (see below).
  const carrierId =
    srcTouch?.id ?? (plan.join.kind === 'elk' ? plan.join.id : undefined) ?? tgtTouch?.id;
  // Pre-measured caption for the bridge fallback (when no ELK carrier exists).
  const bridgeLabel =
    label !== undefined && carrierId === undefined
      ? ((m) => ({ text: label, width: m.width, height: m.height }))(measureLabel(label, ctx.measure))
      : undefined;

  const addSegment = (s: { id: string; from: string; to: string; container: string; arrow: ArrowEnd }): void => {
    const container = ctx.nodeById.get(s.container);
    if (!container) return;
    const edge: DrawnEdge = { id: s.id, sources: [s.from], targets: [s.to] };
    if (label !== undefined && s.id === carrierId) applyEdgeLabel(edge, label, ctx.measure);
    (container.edges ??= []).push(edge);
    styles.set(s.id, {
      arrow: s.arrow,
      invalid: style.invalid,
      stroke,
      messageFlow: style.messageFlow,
      dataAssoc: style.dataAssoc,
      circle: s.id === circleSegId ? 'start' : undefined,
      slashStart: s.id === srcSlashSegId || s.id === tgtSlashSegId,
    });
  };

  for (const p of plan.source.ports) addPort(p);
  for (const p of plan.target.ports) addPort(p);
  for (const s of plan.source.segments) addSegment(s);
  for (const s of plan.target.segments) addSegment(s);

  if (plan.join.kind === 'elk') {
    const joinEdge: DrawnEdge = {
      id: plan.join.id,
      sources: [plan.join.from],
      targets: [plan.join.to],
    };
    if (label !== undefined && plan.join.id === carrierId) {
      applyEdgeLabel(joinEdge, label, ctx.measure);
    }
    (lcaContainer.edges ??= []).push(joinEdge);
    styles.set(plan.join.id, {
      arrow: plan.join.arrow,
      invalid: style.invalid,
      stroke,
      messageFlow: style.messageFlow,
      dataAssoc: style.dataAssoc,
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
        invalid: style.invalid,
        stroke,
        messageFlow: style.messageFlow,
        dataAssoc: style.dataAssoc,
        circle: joinCircle,
        slashStart: joinSlashStart,
        slashEnd: joinSlashEnd,
      },
      bend: plan.join.bend,
      exitSide: plan.join.exitSide,
      enterSide: plan.join.enterSide,
      // No ELK edge exists on the source side to carry an ELK label, so the whole
      // line's caption is drawn by hand near the source (see the bridge draw pass).
      label: bridgeLabel,
    });
  }
}

// The explicit stroke a line should draw with, or undefined for the theme
// default. A relative line inherits from the entity it was written inside; an
// absolute line from the entity at the endpoints' lowest common ancestor.
function lineStroke(
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

// Drops the invisible ordering edges (see chainEdges) that touch a node with a
// real connection: that node is already anchored by its line, so the ordering
// edge is redundant and only risks fighting the real routing. Real connection
// edges (id `conn…`) are always kept.
function pruneOrderingEdges(node: ElkNode, connected: Set<string>): void {
  if (node.edges) {
    node.edges = node.edges.filter(
      (edge) =>
        edge.id.startsWith('conn') ||
        (!connected.has(edge.sources[0]) && !connected.has(edge.targets[0])),
    );
  }
  for (const child of node.children ?? []) pruneOrderingEdges(child, connected);
}

// The subset of ELK's laid-out edge shape the draw pass reads.
interface ElkEdgeSection {
  startPoint: { x: number; y: number };
  endPoint: { x: number; y: number };
  bendPoints?: { x: number; y: number }[];
}
// A laid-out edge label: its box (relative to the edge's container, like the
// section points) and text, filled in by ELK for labelled edges.
interface ElkEdgeLabel {
  text?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}
interface LaidEdge {
  id: string;
  sections?: ElkEdgeSection[];
  labels?: ElkEdgeLabel[];
}

// The arrowhead markers for one diagram. `valid` and `invalid` are the shared
// CSS-colored defaults; `forColor` mints (and caches) a marker filled with a
// specific stroke color. All ids are scoped by the svg id so diagrams on one page
// don't collide.
interface Markers {
  valid: string;
  invalid: string;
  forColor(color: string): string;
  // A message flow's hollow (background-filled, outlined) arrowhead and its open
  // origin circle. `color` overrides the outline (a line with an explicit stroke);
  // undefined uses the theme line color. Both are cached per color.
  messageEnd(color?: string): string;
  messageStart(color?: string): string;
  // A data association's open "V" arrowhead (line-only, no fill), colored like the
  // message markers. Cached per color.
  dataArrow(color?: string): string;
}

// Creates the <defs>, the two default arrowhead markers, and the color/message
// marker factories. `theme` supplies the line and background colors the message
// markers paint with (their fill is the background, their outline the line color).
function createMarkers(
  svg: SVGSVGElement,
  id: string,
  theme: { line: string; background: string },
): Markers {
  const defs = svgEl('defs', {});
  svg.appendChild(defs);
  const valid = `bpmn-arrow-${id}`;
  const invalid = `bpmn-arrow-invalid-${id}`;
  defs.appendChild(arrowMarker(valid, 'bpmn-arrow'));
  defs.appendChild(arrowMarker(invalid, 'bpmn-arrow bpmn-arrow-invalid'));

  let n = 0;
  // A per-color cache keyed by a prefix so the three factories never collide.
  const caches = new Map<string, Map<string, string>>();
  const cached = (prefix: string, color: string | undefined, build: (mid: string) => SVGElement): string => {
    const key = color ?? '';
    const cache = caches.get(prefix) ?? new Map<string, string>();
    caches.set(prefix, cache);
    const hit = cache.get(key);
    if (hit) return hit;
    const mid = `${valid}-${prefix}${n++}`;
    defs.appendChild(build(mid));
    cache.set(key, mid);
    return mid;
  };
  return {
    valid,
    invalid,
    forColor(color: string): string {
      return cached('c', color, (mid) => {
        const marker = arrowMarker(mid, 'bpmn-arrow');
        (marker.firstChild as SVGElement).setAttribute('style', `fill:${color}`);
        return marker;
      });
    },
    messageEnd(color?: string): string {
      return cached('m', color, (mid) =>
        hollowArrowMarker(mid, theme.background, color ?? theme.line),
      );
    },
    messageStart(color?: string): string {
      return cached('o', color, (mid) =>
        circleMarker(mid, theme.background, color ?? theme.line),
      );
    },
    dataArrow(color?: string): string {
      return cached('d', color, (mid) => openArrowMarker(mid, color ?? theme.line));
    },
  };
}

// Draws the connection polylines, threading the same accumulated (ox, oy) the
// node pass uses so an edge's container-relative points land in absolute space.
function drawEdges(
  svg: SVGSVGElement,
  node: ElkNode,
  ox: number,
  oy: number,
  styles: Map<string, ConnStyle>,
  markers: Markers,
  gates: AbsRect[],
): void {
  const originX = ox + (node.x ?? 0);
  const originY = oy + (node.y ?? 0);

  for (const edge of (node.edges ?? []) as LaidEdge[]) {
    const style = styles.get(edge.id);
    if (!style) continue;
    const section = edge.sections?.[0];
    if (!section) continue;

    const pts = [section.startPoint, ...(section.bendPoints ?? []), section.endPoint].map((p) => ({
      x: originX + p.x,
      y: originY + p.y,
    }));
    clipEndsToGates(pts, gates);
    drawEdgePolyline(svg, pts, style, markers);

    // An ELK-placed line caption: its box is relative to this edge's container,
    // like the section points, so it shares the same origin.
    for (const lbl of edge.labels ?? []) {
      if (lbl.text) {
        drawEdgeLabel(
          svg,
          originX + (lbl.x ?? 0),
          originY + (lbl.y ?? 0),
          lbl.width ?? 0,
          lbl.height ?? 0,
          lbl.text,
        );
      }
    }
  }

  for (const child of node.children ?? []) {
    drawEdges(svg, child, originX, originY, styles, markers, gates);
  }
}

// Draws a line caption inside its laid-out (or hand-placed) box, centred and with
// a transparent background. `x`/`y` are the box's top-left in absolute space.
function drawEdgeLabel(
  svg: SVGSVGElement,
  x: number,
  y: number,
  width: number,
  height: number,
  text: string,
): void {
  const cx = x + width / 2;
  const cy = y + height / 2;
  const lines = text.split('\n');
  const t = svgEl('text', {
    x: cx,
    y: cy,
    'text-anchor': 'middle',
    'dominant-baseline': 'central',
    class: 'bpmn-label',
  });
  fillLabelLines(t, lines, cx, centeredFirstDy(lines.length));
  svg.appendChild(t);
}

// Draws one connection line as a rounded <path>: the `bpmn-edge` class (plus
// `-invalid`, `bpmn-data-assoc` for a dotted data association, or
// `bpmn-message-flow` for a dashed cross-pool message flow), an inline stroke
// override when the line carries a color, and the matching markers. A message flow
// gets a hollow arrowhead and an open origin circle on the opposite end; a data
// association gets an open "V" arrowhead; an ordinary line gets the solid
// arrowhead. The orthogonal point list is first diagonalized (narrow S-bends → lane
// changes) then rounded. Shared by ELK-routed and hand-routed edges.
function drawEdgePolyline(
  svg: SVGSVGElement,
  points: Pt[],
  style: ConnStyle,
  markers: Markers,
): void {
  const cls = style.invalid
    ? 'bpmn-edge bpmn-edge-invalid'
    : style.dataAssoc
      ? 'bpmn-edge bpmn-data-assoc'
      : style.messageFlow
        ? 'bpmn-edge bpmn-message-flow'
        : 'bpmn-edge';
  const shaped = diagonalizeSteps(points, LINE_CORNER_RADIUS);
  const line = svgEl('path', { d: roundedPath(shaped, LINE_CORNER_RADIUS), class: cls });
  if (style.stroke) line.setAttribute('style', `stroke:${style.stroke}`);

  const arrowId = style.invalid
    ? markers.invalid
    : style.dataAssoc
      ? markers.dataArrow(style.stroke)
      : style.messageFlow
        ? markers.messageEnd(style.stroke)
        : style.stroke
          ? markers.forColor(style.stroke)
          : markers.valid;
  if (style.arrow === 'end') line.setAttribute('marker-end', `url(#${arrowId})`);
  if (style.arrow === 'start') line.setAttribute('marker-start', `url(#${arrowId})`);

  // The origin circle sits on the end opposite the arrowhead (see ConnStyle.circle).
  if (style.messageFlow && style.circle) {
    const circleId = markers.messageStart(style.stroke);
    const end = style.circle === 'start' ? 'marker-start' : 'marker-end';
    line.setAttribute(end, `url(#${circleId})`);
  }
  svg.appendChild(line);

  // Slash ticks are drawn as their own short <line>s (not SVG markers) so they
  // never contend with the arrowhead/origin-circle markers for the same end, and
  // so their 45° angle is taken from the polyline's own first/last run. `shaped`
  // is source-point-first, so its start is `slashStart` and its end `slashEnd`.
  if ((style.slashStart || style.slashEnd) && shaped.length >= 2) {
    const n = shaped.length;
    if (style.slashStart) svg.appendChild(slashMark(shaped[0], shaped[1], style.stroke));
    if (style.slashEnd) svg.appendChild(slashMark(shaped[n - 1], shaped[n - 2], style.stroke));
  }
}

// A short diagonal tick across a line end (a leading/trailing `/` connector —
// BPMN's default-sequence-flow marker when at the source). `end` is the endpoint
// the tick sits near; `inward` the next polyline point, giving the flow direction.
// The tick's centre is set SLASH_INSET inside the endpoint and its own direction is
// the flow rotated 45°, so it reads as a slash crossing the line.
function slashMark(end: Pt, inward: Pt, stroke?: string): SVGLineElement {
  const dx = inward.x - end.x;
  const dy = inward.y - end.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const cx = end.x + ux * SLASH_INSET;
  const cy = end.y + uy * SLASH_INSET;
  // Flow direction rotated +45° (cos45 = sin45 = SQRT1_2).
  const rx = (ux - uy) * Math.SQRT1_2;
  const ry = (ux + uy) * Math.SQRT1_2;
  const h = SLASH_LEN / 2;
  const mark = svgEl('line', {
    x1: cx - rx * h,
    y1: cy - ry * h,
    x2: cx + rx * h,
    y2: cy + ry * h,
    class: 'bpmn-edge-slash',
  });
  if (stroke) mark.setAttribute('style', `stroke:${stroke}`);
  return mark;
}

// An axis-aligned rectangle in absolute diagram coordinates.
interface AbsRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Records every node's absolute box by threading the accumulated offset down the
// laid-out tree, so hand-routed edges can find their endpoints' positions. Port
// positions (relative to their owning node) are resolved to absolute points in
// the same walk, so a bridge can start from a laid-out port.
function collectAbsRects(
  node: ElkNode,
  ox: number,
  oy: number,
  out: Map<string, AbsRect>,
  ports: Map<string, { x: number; y: number }>,
): void {
  const x = ox + (node.x ?? 0);
  const y = oy + (node.y ?? 0);
  out.set(node.id, { x, y, w: node.width ?? 0, h: node.height ?? 0 });
  for (const port of (node as { ports?: { id: string; x?: number; y?: number }[] }).ports ?? []) {
    ports.set(port.id, { x: x + (port.x ?? 0), y: y + (port.y ?? 0) });
  }
  for (const child of node.children ?? []) collectAbsRects(child, x, y, out, ports);
}

type Pt = { x: number; y: number };

// The travel axis of a line touching a box on `side`: it leaves e/w edges
// horizontally, n/s edges vertically. Events (circles) and gates (diamonds) have
// no straight edge, so the side names the bounding box's edge, as elsewhere.
function sideAxis(side: Side): 'h' | 'v' {
  return side === 'e' || side === 'w' ? 'h' : 'v';
}

// The midpoint of one bounding-box edge.
function edgePoint(r: AbsRect, side: Side): Pt {
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  switch (side) {
    case 'n':
      return { x: cx, y: r.y };
    case 's':
      return { x: cx, y: r.y + r.h };
    case 'w':
      return { x: r.x, y: cy };
    case 'e':
      return { x: r.x + r.w, y: cy };
  }
}

// A single-corner (L) route: leave the source along `exitSide`'s axis, turn once,
// enter the target on the perpendicular axis. The turn axis is taken from the
// source edge (HV when it exits e/w, VH when it exits n/s); the target attaches on
// the enter edge when that is already perpendicular, else on the box side geometry
// puts nearest the corner.
function lPoints(s: AbsRect, t: AbsRect, exitSide: Side, enterSide: Side): Pt[] {
  const scx = s.x + s.w / 2;
  const scy = s.y + s.h / 2;
  const tcx = t.x + t.w / 2;
  const tcy = t.y + t.h / 2;
  if (sideAxis(exitSide) === 'h') {
    // Horizontal then vertical: corner shares the source's y and the target's x.
    const tSide: Side = sideAxis(enterSide) === 'v' ? enterSide : tcy >= scy ? 'n' : 's';
    const sp = edgePoint(s, exitSide);
    const tp = edgePoint(t, tSide);
    return [sp, { x: tp.x, y: sp.y }, tp];
  }
  // Vertical then horizontal: corner shares the source's x and the target's y.
  const tSide: Side = sideAxis(enterSide) === 'h' ? enterSide : tcx >= scx ? 'w' : 'e';
  const sp = edgePoint(s, exitSide);
  const tp = edgePoint(t, tSide);
  return [sp, { x: sp.x, y: tp.y }, tp];
}

// A simple orthogonal route between two boxes for an edge ELK didn't route.
// `z`/`n` are the symmetric HVH/VHV shapes; `l` is a single corner. `auto` (and an
// absent bend) picks `l` when the exit and enter edges are perpendicular, else the
// axis the two ends are more separated along.
//
// `*Fixed` marks an endpoint whose attach edge is pinned — the anchor is a port
// (a routing port on a container border, or a declared `port`), so the line MUST
// leave/enter along that edge's axis. When either end is fixed the auto z/n choice
// takes its axis from that edge (source first) instead of the endpoints' geometry,
// the same way `l` honours the exit edge. Exported for unit tests.
export function orthogonalPoints(
  s: AbsRect,
  t: AbsRect,
  bend?: 'z' | 'n' | 'l' | 'auto',
  exitSide?: Side,
  enterSide?: Side,
  sourceFixed?: boolean,
  targetFixed?: boolean,
): Pt[] {
  const scx = s.x + s.w / 2;
  const scy = s.y + s.h / 2;
  const tcx = t.x + t.w / 2;
  const tcy = t.y + t.h / 2;
  const perpendicular =
    exitSide != null && enterSide != null && sideAxis(exitSide) !== sideAxis(enterSide);
  if (bend === 'l' || ((bend == null || bend === 'auto') && perpendicular)) {
    // Explicit `l` with no resolved sides falls back to the dominant axis so the
    // single corner still leaves along the way the boxes are more separated.
    const ex = exitSide ?? (Math.abs(tcx - scx) >= Math.abs(tcy - scy) ? (tcx >= scx ? 'e' : 'w') : tcy >= scy ? 's' : 'n');
    const en = enterSide ?? OPPOSITE[ex];
    return lPoints(s, t, ex, en);
  }
  const verticalFirst =
    bend === 'n'
      ? true
      : bend === 'z'
        ? false
        : sourceFixed && exitSide != null
          ? sideAxis(exitSide) === 'v'
          : targetFixed && enterSide != null
            ? sideAxis(enterSide) === 'v'
            : Math.abs(tcy - scy) >= Math.abs(tcx - scx);
  if (verticalFirst) {
    const sy = tcy >= scy ? s.y + s.h : s.y;
    const ty = tcy >= scy ? t.y : t.y + t.h;
    const midY = (sy + ty) / 2;
    return [{ x: scx, y: sy }, { x: scx, y: midY }, { x: tcx, y: midY }, { x: tcx, y: ty }];
  }
  const sx = tcx >= scx ? s.x + s.w : s.x;
  const tx = tcx >= scx ? t.x : t.x + t.w;
  const midX = (sx + tx) / 2;
  return [{ x: sx, y: scy }, { x: midX, y: scy }, { x: midX, y: tcy }, { x: tx, y: tcy }];
}

// The unit vector from `from` to `to` (a zero-length pair yields a zero vector via
// the |len|-or-1 guard, harmless because it is only scaled by a zero setback).
function unit(from: Pt, to: Pt): Pt {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: dx / len, y: dy / len };
}

// Builds an SVG path `d` from a point list, rounding each interior vertex with a
// quadratic bezier. Per corner, back off t = min(radius, din/2, dout/2) along both
// incident segments (`L` to the entry point, then `Q vertex exit`). Clamping to
// HALF of each incident segment is the key invariant: a segment shared by two
// corners (a tight S's short middle run) can't be over-eaten, so the two arcs meet
// at the midpoint instead of overshooting into a self-crossing loop. Endpoints are
// never rounded; zero-length or collinear vertices pass straight through. Exported
// for unit tests.
export function roundedPath(pts: Pt[], radius: number): string {
  if (pts.length === 0) return '';
  if (pts.length < 3) {
    return pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ');
  }
  const parts: string[] = [`M${pts[0].x},${pts[0].y}`];
  for (let i = 1; i < pts.length - 1; i++) {
    const v = pts[i];
    const a = pts[i - 1];
    const b = pts[i + 1];
    const dinx = v.x - a.x;
    const diny = v.y - a.y;
    const doutx = b.x - v.x;
    const douty = b.y - v.y;
    const din = Math.hypot(dinx, diny);
    const dout = Math.hypot(doutx, douty);
    // A zero-length or collinear vertex has nothing to round; emit a plain line to
    // it (a rounded corner here would be degenerate or a no-op arc on the line).
    const cross = din > 1e-6 && dout > 1e-6 ? (dinx * douty - diny * doutx) / (din * dout) : 0;
    if (din < 1e-6 || dout < 1e-6 || Math.abs(cross) < 1e-6) {
      parts.push(`L${v.x},${v.y}`);
      continue;
    }
    const t = Math.min(radius, din / 2, dout / 2);
    const inx = v.x - (dinx / din) * t;
    const iny = v.y - (diny / din) * t;
    const outx = v.x + (doutx / dout) * t;
    const outy = v.y + (douty / dout) * t;
    parts.push(`L${inx},${iny}`);
    parts.push(`Q${v.x},${v.y} ${outx},${outy}`);
  }
  const last = pts[pts.length - 1];
  parts.push(`L${last.x},${last.y}`);
  return parts.join(' ');
}

// Detects a "step": two axis-aligned, parallel, SAME-direction runs (a→v and w→b)
// joined by a short perpendicular jog (v→w) whose length is below maxJog. This is
// the narrow-S shape that diagonalizes into a lane change. L-turns (the runs are
// perpendicular) and U-turns (the runs are opposite-direction) are rejected.
// Epsilon-tolerant for ELK's floating-point coordinates.
function isStep(a: Pt, v: Pt, w: Pt, b: Pt, maxJog: number): boolean {
  const e = 1e-6;
  const r1x = v.x - a.x;
  const r1y = v.y - a.y;
  const jx = w.x - v.x;
  const jy = w.y - v.y;
  const r2x = b.x - w.x;
  const r2y = b.y - w.y;
  if (Math.abs(r1y) < e && Math.abs(r1x) > e) {
    // First run horizontal: the second must be horizontal and same-direction, the
    // jog purely vertical and short.
    if (!(Math.abs(r2y) < e && Math.abs(r2x) > e)) return false;
    if (Math.sign(r1x) !== Math.sign(r2x)) return false;
    if (!(Math.abs(jx) < e && Math.abs(jy) > e)) return false;
    return Math.abs(jy) < maxJog;
  }
  if (Math.abs(r1x) < e && Math.abs(r1y) > e) {
    // First run vertical: mirror of the above.
    if (!(Math.abs(r2x) < e && Math.abs(r2y) > e)) return false;
    if (Math.sign(r1y) !== Math.sign(r2y)) return false;
    if (!(Math.abs(jy) < e && Math.abs(jx) > e)) return false;
    return Math.abs(jx) < maxJog;
  }
  return false;
}

// Rewrites every narrow step (see isStep) into a short diagonal, replacing the two
// jog vertices with the pair of diagonal anchors; roundedPath then rounds the
// resulting non-90° corners for free. Wider S-bends (jog ≥ 2·radius) are left as
// two plain rounded corners. Exported for unit tests.
//
// Per side the setback `d` targets `radius`, clamped by the run it eats into:
//   - a TERMINAL run (the segment touches the line's own start/end) reserves a full
//     radius of perpendicular run — so the line leaves a box at 90° and then curves
//     into the diagonal; if the run is shorter than the radius the setback is 0 and
//     the whole run stays perpendicular.
//   - an INTERIOR run shares its length with the corner at its other end, so only
//     half is available.
// Finally the total spread d0+d1 is capped at jog/tan(DIAGONAL_MIN_ANGLE): if the
// ramp would be shallower than the min angle, both setbacks scale down together so
// the diagonal sits at exactly that angle.
export function diagonalizeSteps(pts: Pt[], radius: number): Pt[] {
  if (pts.length < 4) return pts;
  const maxJog = 2 * radius;
  const out = pts.map((p) => ({ x: p.x, y: p.y }));
  const last = pts.length - 1;
  for (let i = 1; i + 2 <= last; i++) {
    const a = out[i - 1];
    const v = out[i];
    const w = out[i + 1];
    const b = out[i + 2];
    if (!isStep(a, v, w, b, maxJog)) continue;
    const runIn = Math.hypot(v.x - a.x, v.y - a.y);
    const runOut = Math.hypot(b.x - w.x, b.y - w.y);
    const jog = Math.hypot(w.x - v.x, w.y - v.y);
    const availIn = i - 1 === 0 ? Math.max(0, runIn - radius) : runIn / 2;
    const availOut = i + 2 === last ? Math.max(0, runOut - radius) : runOut / 2;
    let d0 = Math.min(radius, availIn);
    let d1 = Math.min(radius, availOut);
    const maxSpread = jog / Math.tan(DIAGONAL_MIN_ANGLE);
    if (d0 + d1 > maxSpread && d0 + d1 > 0) {
      const scale = maxSpread / (d0 + d1);
      d0 *= scale;
      d1 *= scale;
    }
    const uIn = unit(a, v);
    const uOut = unit(w, b);
    out[i] = { x: v.x - uIn.x * d0, y: v.y - uIn.y * d0 };
    out[i + 1] = { x: w.x + uOut.x * d1, y: w.y + uOut.y * d1 };
  }
  return out;
}

// A line arriving at a gateway stops at the diamond's bounding box, leaving a gap
// to its slanted edge. Since the diamond is inscribed in the box, we pull an
// endpoint that landed on the box border inward along its (axis-aligned) terminal
// segment until it meets the diamond edge. Only the two endpoints move, so the
// route's shape is otherwise unchanged.
function onGateBorder(p: Pt, g: AbsRect): boolean {
  const e = 0.5;
  const onX = (Math.abs(p.x - g.x) < e || Math.abs(p.x - (g.x + g.w)) < e) && p.y >= g.y - e && p.y <= g.y + g.h + e;
  const onY = (Math.abs(p.y - g.y) < e || Math.abs(p.y - (g.y + g.h)) < e) && p.x >= g.x - e && p.x <= g.x + g.w + e;
  return onX || onY;
}
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
function clipEndsToGates(pts: Pt[], gates: AbsRect[]): void {
  if (pts.length < 2 || gates.length === 0) return;
  const clip = (i: number, j: number): void => {
    const g = gates.find((g) => onGateBorder(pts[i], g));
    if (g) pts[i] = clipToDiamond(pts[i], pts[j], g);
  };
  clip(0, 1);
  clip(pts.length - 1, pts.length - 2);
}

function arrowMarker(id: string, className: string): SVGMarkerElement {
  const marker = svgEl('marker', {
    id,
    viewBox: '0 0 10 10',
    refX: 9,
    refY: 5,
    markerWidth: 7,
    markerHeight: 7,
    orient: 'auto-start-reverse',
  });
  marker.appendChild(svgEl('path', { d: 'M0,0 L10,5 L0,10 Q3,5 0,0 z', class: className }));
  return marker;
}

// A message flow's hollow arrowhead: the same triangle as the solid arrow, but
// filled with the background and outlined in the line color (so it reads as an
// open head over whatever it sits on). Colors are inlined, not class-driven.
function hollowArrowMarker(id: string, fill: string, stroke: string): SVGMarkerElement {
  const marker = svgEl('marker', {
    id,
    viewBox: '0 0 10 10',
    refX: 9,
    refY: 5,
    markerWidth: 8,
    markerHeight: 8,
    orient: 'auto-start-reverse',
  });
  const path = svgEl('path', { d: 'M0,0 L10,5 L0,10 Q3,5 0,0 z' });
  path.setAttribute('style', `fill:${fill};stroke:${stroke};stroke-width:1`);
  marker.appendChild(path);
  return marker;
}

// A data association's open "V" arrowhead: two strokes meeting at the tip, with no
// fill (the polyline is left unclosed). Stroked in the line color.
function openArrowMarker(id: string, stroke: string): SVGMarkerElement {
  const marker = svgEl('marker', {
    id,
    viewBox: '0 0 10 10',
    refX: 9,
    refY: 5,
    markerWidth: 9,
    markerHeight: 9,
    orient: 'auto-start-reverse',
  });
  const path = svgEl('path', { d: 'M1,1 L9,5 L1,9' });
  path.setAttribute('style', `fill:none;stroke:${stroke};stroke-width:1.5`);
  marker.appendChild(path);
  return marker;
}

// A message flow's origin circle: a small open circle (background fill, line-color
// outline) centred on the endpoint. Orientation is irrelevant for a circle.
function circleMarker(id: string, fill: string, stroke: string): SVGMarkerElement {
  const marker = svgEl('marker', {
    id,
    viewBox: '0 0 10 10',
    refX: 5,
    refY: 5,
    markerWidth: 8,
    markerHeight: 8,
    orient: 'auto',
  });
  const circle = svgEl('circle', { cx: 5, cy: 5, r: 3.5 });
  circle.setAttribute('style', `fill:${fill};stroke:${stroke};stroke-width:1`);
  marker.appendChild(circle);
  return marker;
}

// Read-only indexes the draw pass needs, plus `regionRects` — a scratch map it
// fills top-down with each region's interior-tiling fill rect (keyed by node id)
// so a region draws with the expanded box its parent computed for it.
interface DrawCtx {
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
}

// Orders a sibling list so region subtrees come first. SVG has no z-index — paint
// order is document order — so drawing regions before their siblings keeps a
// region's fill beneath the boxes that share its container. Stable.
function regionsFirst(nodes: ElkNode[], types: Map<string, EntityType>): ElkNode[] {
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
function equalisePoolLengths(laid: ElkNode, ctx: BuildCtx): boolean {
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
function iconEl(icon: IconSvg, x: number, y: number, size: number): SVGElement {
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

// Fills a <text> with a caption, drawing one <tspan> row per line when it spans
// several (a `\n` escape or a `|` multi-line label). `firstDy` places the first row
// relative to the text's `y`; each later row steps down one line height. A single
// line is set directly, so its geometry is byte-for-byte what it was before.
function fillLabelLines(
  text: SVGTextElement,
  lines: string[],
  x: number,
  firstDy: number,
): void {
  if (lines.length <= 1) {
    text.textContent = lines[0] ?? '';
    return;
  }
  lines.forEach((line, i) => {
    // Each tspan re-anchors x (SVG advances it otherwise) and steps down by dy.
    const tspan = svgEl('tspan', { x, dy: i === 0 ? firstDy : LABEL_LINE_H });
    tspan.textContent = line;
    text.appendChild(tspan);
  });
}

// The first row's `dy` that centres a block of `n` rows on the text's `y` (each row
// drawn with a central baseline).
function centeredFirstDy(n: number): number {
  return -((n - 1) * LABEL_LINE_H) / 2;
}

// Builds a centred `[icon] caption` group whose overall centre is the local origin
// (0, 0); the caller positions it with a transform on the returned <g>. Either
// part may be absent: icon-only, or text-only. A multi-line caption stacks its rows
// centred on that origin.
function iconLabelContent(
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
    const textX = left + iconW + gap + labelWidth / 2;
    const lines = caption.split('\n');
    const text = svgEl('text', {
      x: textX,
      y: 0,
      'text-anchor': 'middle',
      'dominant-baseline': 'central',
      class: labelClass,
    });
    fillLabelLines(text, lines, textX, centeredFirstDy(lines.length));
    g.appendChild(text);
  }
  return g;
}

// Draws a pool/lane label inside its band — the strip along the flow's start edge
// (west for LR, east for RL, north for TB, south for BT), rotated to run along the
// band (bottom-to-top on a side band, horizontal on a top/bottom band).
function drawBandLabel(
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
function drawOutsideLabel(svg: SVGSVGElement, node: ElkNode, x: number, y: number): void {
  const lbl = (
    node as { labels?: { text?: string; x?: number; y?: number; width?: number; height?: number }[] }
  ).labels?.[0];
  if (!lbl?.text) return;
  const cx = x + (lbl.x ?? 0) + (lbl.width ?? 0) / 2;
  const cy = y + (lbl.y ?? 0) + (lbl.height ?? 0) / 2;
  const lines = lbl.text.split('\n');
  const text = svgEl('text', {
    x: cx,
    y: cy,
    'text-anchor': 'middle',
    'dominant-baseline': 'central',
    class: 'bpmn-label',
  });
  fillLabelLines(text, lines, cx, centeredFirstDy(lines.length));
  svg.appendChild(text);
}

// Draws an event's circle(s), their outline chosen by the event operation: a thin
// single ring for a start, a bold single ring for an end, a thin double ring for an
// intermediate (catch/throw) or boundary event, and a dashed ring for a
// non-interrupting one (single dashed for a start, double dashed for a boundary).
// The type marker is drawn on top separately (see drawNode).
function drawEventShape(
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
  const sw = op === 'end' ? EVENT_THICK : 1.5;
  const outerR = box.w / 2 - sw / 2;
  const ring = (r: number, filled: boolean): SVGElement => {
    let s = `fill:${filled ? fill : 'none'}`;
    if (stroke) s += `;stroke:${stroke}`;
    if (sw !== 1.5) s += `;stroke-width:${sw}`;
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
function drawBoundaryEvent(
  svg: SVGSVGElement,
  box: Rect,
  be: {
    op: EventOperation | undefined;
    resolved: Resolved | undefined;
    caption: string;
    labelBox: LabelBox | null;
  },
  icons: Map<string, IconSvg>,
): void {
  drawEventShape(svg, box, be.resolved, be.op);
  const iconSvg = be.resolved?.icon ? icons.get(be.resolved.icon) : undefined;
  if (iconSvg) {
    svg.appendChild(
      iconEl(iconSvg, box.x + box.w / 2 - EVENT_ICON / 2, box.y + box.h / 2 - EVENT_ICON / 2, EVENT_ICON),
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
    const lines = be.caption.split('\n');
    // Rows grow away from the anchored edge: a top-anchored (hanging) caption steps
    // DOWN from its first row, a bottom-anchored (auto) one is lifted so its rows end
    // at the anchor, and a centred one is balanced about it.
    const firstDy =
      vert.baseline === 'hanging'
        ? 0
        : vert.baseline === 'auto'
          ? -(lines.length - 1) * LABEL_LINE_H
          : centeredFirstDy(lines.length);
    const text = svgEl('text', {
      x: horiz.x,
      y: vert.y,
      'text-anchor': horiz.anchor,
      'dominant-baseline': vert.baseline,
      class: 'bpmn-label',
    });
    fillLabelLines(text, lines, horiz.x, firstDy);
    svg.appendChild(text);
  }
}

// Draws an activity's rounded-rectangle outline, its border chosen by the activity
// type: `task`/`subprocess` keep the plain single border; `call` and
// `call-subprocess` get a bold (double width) one; `event-subprocess` a dotted one;
// `transaction` a double
// outline drawn with thinner lines (an inner rect inset from the outer). The fill
// rides on the outer/only rect; the transaction's inner rect is unfilled so the
// fill shows through the gap between the two lines.
function drawActivityShape(
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
function drawDataShape(
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

// Draws a text annotation (`comment`): a transparent box (painted only when a
// `fill` is set) with a bold, open bracket on one edge. `side` is which edge — a
// `[` on the west, `]` on the east, and the top/bottom variants — the BPMN
// text-annotation cue. The bracket takes the resolved stroke, or the theme default.
function drawTextShape(
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
function nearestSide(from: AbsRect, to: AbsRect): Side {
  const dx = to.x + to.w / 2 - (from.x + from.w / 2);
  const dy = to.y + to.h / 2 - (from.y + from.h / 2);
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'e' : 'w';
  return dy >= 0 ? 's' : 'n';
}

// Resolves which edge a text annotation's bracket sits on: an explicit side wins;
// otherwise (auto) the first declared port's side, then the side facing the first
// connected entity, and finally the west edge. The line/geometry fallbacks need the
// laid-out boxes, so this runs after layout.
function resolveBracketSide(
  entity: Entity,
  nodeId: string,
  idOf: Map<Entity, string>,
  nameIndex: Map<string, Entity>,
  absRects: Map<string, AbsRect>,
  lines: Line[],
): Side {
  if (entity.bracketSide) return entity.bracketSide;
  const port = entity.children.find((c) => c.type === 'port' && c.portSide);
  if (port?.portSide) return port.portSide;
  const self = absRects.get(nodeId);
  if (self) {
    const resolve = (ep: Entity | string): Entity | undefined =>
      typeof ep === 'string' ? nameIndex.get(ep) : ep;
    for (const line of lines) {
      const s = resolve(line.source);
      const t = resolve(line.target);
      const other = s === entity ? t : t === entity ? s : undefined;
      if (!other) continue;
      const orect = idOf.get(other) && absRects.get(idOf.get(other) as string);
      if (orect) return nearestSide(self, orect);
    }
  }
  return 'w';
}

// Draws an activity's marker glyphs as a row centred along the bottom edge of its
// box (within the MARKER_BAND the build pass reserved). Only glyphs that resolved
// are drawn; the row is centred on however many that is.
function drawMarkers(
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
function drawNode(
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
      svg.appendChild(iconEl(iconSvg, x + w / 2 - GATE_ICON / 2, y + h / 2 - GATE_ICON / 2, GATE_ICON));
    }
    drawOutsideLabel(svg, node, x, y);
  } else if (type === 'event') {
    // An event draws its type marker (chosen by event type + operation) centred in
    // the circle (a blank event has none — just the ring), and its caption outside.
    if (iconSvg) {
      svg.appendChild(iconEl(iconSvg, x + w / 2 - EVENT_ICON / 2, y + h / 2 - EVENT_ICON / 2, EVENT_ICON));
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
      const g = iconLabelContent(iconSvg, iconPx(iconFactor, ICON_SIZE), caption, 'bpmn-label', labelWidth);
      g.setAttribute('transform', `translate(${x + w / 2} ${y + h / 2})${vertical ? ' rotate(-90)' : ''}`);
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
function classFor(type: EntityType, isContainer: boolean): string {
  const classes = type === 'region' ? ['bpmn-region'] : ['bpmn-entity', `bpmn-${type}`];
  if (isContainer) classes.push('bpmn-container');
  return classes.join(' ');
}

// Builds the outline element for an entity. A gateway is a diamond; a region is a
// borderless rectangle (transparent unless a `fill` is set); a group is a
// round-cornered rectangle (its dash-dot stroke comes from CSS); pools/lanes and
// containers are plain rectangles. Activities and events draw their own shapes
// (see drawActivityShape / drawEventShape) and never reach here. Fill (and an
// explicit stroke, when set) is applied via an inline `style` so it wins over the
// CSS defaults.
function shapeFor(
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
    // A root that holds pools stacks them ACROSS the diagram flow, exactly as a
    // pool stacks its lanes: the ELK layout direction toggles (TB↔LR, BT↔RL) while
    // the pools still inherit the original flow. Layout-only; `direction` (the
    // inherited flow) is unchanged.
    const rootHasPools = entities.some((e) => e.type === 'pool');
    const rootLayoutDir = rootHasPools ? TOGGLE_AXIS[direction] : direction;
    const { measure, done } = makeMeasurer(svg);

    // Resolve every entity's fill/outline/icon once (classes, `style`, inheritance,
    // theme fallbacks) up front, since the build pass reads each entity's icon to
    // reserve room. Indexed by node id for the draw pass below.
    const theme = renderTheme();
    const resolved = resolveStyles(
      entities,
      db.getClassDefs(),
      db.getNamedStyles(),
      db.getNamedClasses(),
      theme,
      db.getRootStyle(),
    );

    // Every entity referenced by a line, resolved through a first-wins name index
    // over the whole tree (as endpoints resolve elsewhere). A boundary event reads
    // it to know whether it has a line, and so must move its caption clear of it.
    const nameIndex = new Map<string, Entity>();
    const indexNames = (e: Entity): void => {
      if (e.name && !nameIndex.has(e.name)) nameIndex.set(e.name, e);
      e.children.forEach(indexNames);
    };
    db.getRoot().children.forEach(indexNames);
    const lineEntities = new Set<Entity>();
    for (const line of db.getLines()) {
      const s = typeof line.source === 'string' ? nameIndex.get(line.source) : line.source;
      const t = typeof line.target === 'string' ? nameIndex.get(line.target) : line.target;
      if (s) lineEntities.add(s);
      if (t) lineEntities.add(t);
    }

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
      flowById: new Map(),
      eventOpById: new Map(),
      activityTypeById: new Map(),
      markerSpecsById: new Map(),
      dataTypeById: new Map(),
      ports: new Map(),
      declaredPortIds: new Set(),
      debugPorts: db.getDebugPorts(),
      boundaryEvents: new Map(),
      boundaryAutoSide: resolveBoundaryAutoSides(db.getRoot(), direction, db.getLines()),
      lineEntities,
      boundaryInsetById: new Map(),
    };

    // Only supported families become nodes; the declaration index is kept in the
    // id even across skipped entities so ids stay unique and stable.
    const rootChildren: ElkNode[] = [];
    entities.forEach((entity, i) => {
      if (SUPPORTED_TYPES.has(entity.type)) {
        rootChildren.push(toElkNode(entity, `n${i}`, direction, ctx, true));
      }
    });
    const rootOpts = containerOptions(rootLayoutDir, CONTAINER_PAD);
    if (rootHasPools) {
      // Pools are swimlanes: they must stack in a straight, aligned column (or row),
      // sharing a cross-axis origin regardless of the message flows running between
      // them. ELK's default node placement (Brandes-Köpf) shifts a pool sideways to
      // shorten those cross-pool edges, which breaks the alignment; SIMPLE placement
      // stacks each pool flush at the layer origin instead, so same-orientation pools
      // line up. Edges are still routed — just not at the cost of the stack.
      rootOpts['elk.layered.nodePlacement.strategy'] = 'SIMPLE';
    }
    const graph: ElkNode = {
      id: 'root',
      layoutOptions: rootOpts,
      children: rootChildren,
      edges: [],
    };
    (graph as { edges: unknown[] }).edges = chainEdges('root', rootChildren);

    // Whole-graph port line validation, decided up front so every connection can
    // ask about itself.
    const validation = analysePorts(entities, db.getLines());
    // Append the real connections now that every node id is known, then drop the
    // ordering edges a real connection has made redundant.
    const { styles: connStyles, connected, hierarchyContainers, manualEdges } = addConnections(
      graph,
      db.getLines(),
      ctx,
      resolved,
      // Root-LCA routing derives its exit axis from the root's layout direction, so
      // it must see the toggled direction (not the inherited flow) to match ELK.
      rootLayoutDir,
      validation,
    );
    for (const container of hierarchyContainers) {
      const opts = (container.layoutOptions ??= {}) as Record<string, string>;
      opts['elk.hierarchyHandling'] = 'INCLUDE_CHILDREN';
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

    // Pools that share a flow direction are stretched to a common length so a stack
    // of them lines up flush (like a pool's lanes). This needs the laid-out lengths,
    // so it runs after the first layout and, when it pins any pool, lays out once
    // more — ELK then re-places each pool's content and re-aligns the stack.
    if (equalisePoolLengths(laid, ctx)) {
      laid = await elk.layout(graph);
    }

    // Resolve any referenced icons to inline SVG (loading lazy packs on the way).
    // Skipped entirely when the diagram uses none.
    const iconSpecs = new Set<string>();
    for (const r of resolved.values()) if (r.icon) iconSpecs.add(r.icon);
    // Activity marker glyphs (composite `+`, loop/multi-instance) are resolved too,
    // though they live outside the per-entity `icon` slot (see markerSpecsById).
    for (const specs of ctx.markerSpecsById.values()) for (const s of specs) iconSpecs.add(s);
    const icons = iconSpecs.size > 0 ? await resolveIcons(iconSpecs) : new Map<string, IconSvg>();

    // Absolute node boxes (and port points) for both the gate-edge clipping below
    // and the hand-drawn bridges. Gateways are diamonds inscribed in these boxes,
    // so edge endpoints landing on their border are pulled in to the diamond edge.
    const absRects = new Map<string, AbsRect>();
    const portPoints = new Map<string, { x: number; y: number }>();
    for (const node of laid.children ?? []) collectAbsRects(node, 0, 0, absRects, portPoints);
    const gateBoxes: AbsRect[] = [];
    for (const [nodeId, box] of absRects) {
      if (ctx.types.get(nodeId) === 'gate') gateBoxes.push(box);
    }

    // Resolve each text annotation's bracket edge now that the geometry is known
    // (an `auto` side may face a connected entity's laid-out box).
    const bracketSideById = new Map<string, Side>();
    for (const [nodeId, entity] of ctx.entityById) {
      if (entity.type !== 'text') continue;
      bracketSideById.set(
        nodeId,
        resolveBracketSide(entity, nodeId, ctx.idOf, nameIndex, absRects, db.getLines()),
      );
    }

    const markers = createMarkers(svg, id, { line: theme.line, background: theme.background });
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
    };
    for (const node of regionsFirst(laid.children ?? [], ctx.types)) {
      drawNode(svg, node, 0, 0, drawCtx);
    }
    drawEdges(svg, laid, 0, 0, connStyles, markers, gateBoxes);

    // Hand-draw the bridge for each boundary-crossing line whose port chains
    // stopped short of the LCA (the ELK-routed chain segments were already drawn
    // above). Each anchor resolves to a box or a laid-out port point.
    if (manualEdges.length > 0) {
      const resolve = (a: Anchor): AbsRect | undefined => {
        if (a.kind === 'box') return absRects.get(a.id);
        const p = portPoints.get(a.portId);
        return p && { x: p.x, y: p.y, w: 0, h: 0 };
      };
      for (const edge of manualEdges) {
        const from = resolve(edge.from);
        const to = resolve(edge.to);
        if (from && to) {
          const pts = orthogonalPoints(
            from,
            to,
            edge.bend,
            edge.exitSide,
            edge.enterSide,
            edge.from.kind === 'port',
            edge.to.kind === 'port',
          );
          clipEndsToGates(pts, gateBoxes);
          drawEdgePolyline(svg, pts, edge.style, markers);
          // A single-bridge line has no ELK edge to carry its caption, so place it
          // by hand near the source: a little in along the first run, offset to the
          // side so it sits beside the line rather than on it.
          if (edge.label && pts.length >= 2) {
            const p0 = pts[0];
            const p1 = pts[1];
            const dx = p1.x - p0.x;
            const dy = p1.y - p0.y;
            const len = Math.hypot(dx, dy) || 1;
            const ux = dx / len;
            const uy = dy / len;
            const along = EDGE_LABEL_INSET + edge.label.width / 2;
            const off = edge.label.height / 2 + EDGE_LABEL_GAP;
            const cx = p0.x + ux * along - uy * off;
            const cy = p0.y + uy * along + ux * off;
            drawEdgeLabel(
              svg,
              cx - edge.label.width / 2,
              cy - edge.label.height / 2,
              edge.label.width,
              edge.label.height,
              edge.label.text,
            );
          }
        }
      }
    }

    // Boundary events last, over their host activity and any edge stub: each draws
    // as an event circle centred on the port point ELK laid out on the host border.
    for (const [portId, be] of ctx.boundaryEvents) {
      const p = portPoints.get(portId);
      if (!p) continue;
      // The port's top-left plus its anchor is the border point; centre the circle
      // there (the port itself is larger, holding the reserved outward label room).
      const cx = p.x + be.anchor.ax;
      const cy = p.y + be.anchor.ay;
      drawBoundaryEvent(svg, { x: cx - EVENT_SIZE / 2, y: cy - EVENT_SIZE / 2, w: EVENT_SIZE, h: EVENT_SIZE }, be, icons);
    }

    const width = Math.max(laid.width ?? 0, LEAF_MIN_W);
    const height = Math.max(laid.height ?? 0, LEAF_H);
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));
  },
};
