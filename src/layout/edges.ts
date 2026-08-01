// Drawing connection edges: ELK-routed polylines, hand-drawn bridges, straight
// comment lines, arrowhead markers, and line labels. Diagram-agnostic — it works
// from laid-out ELK nodes, points, and a resolved per-edge style. The `bpmn-*` CSS
// class names below are the styling contract the layer emits; a different diagram
// style targets the same class names (or forks this file's constants).
import type { ElkNode } from 'elkjs/lib/elk.bundled.js';
import type { Anchor, ArrowEnd } from './routePlan.js';
import type { Side } from './model.js';
import {
  type AbsRect,
  LINE_CORNER_RADIUS,
  type Pt,
  borderPoint,
  diagonalizeSteps,
  roundedPath,
} from './geometry.js';
import { svgEl } from './svg.js';
import { LABEL_LINE_H, captionHeight, captionText } from './text.js';

export const LINE_LABEL_CLASS = 'bpmn-line-label';
const LINE_LABEL_INSET = 24; // distance along the first segment from the source
const LINE_LABEL_GAP = 4; // clearance between the line and the caption

// A line-end slash tick (see ConnStyle.slashStart/slashEnd). SLASH_LEN is the
// tick's drawn length; SLASH_INSET how far along the line from the endpoint its
// centre sits, so it crosses the visible line just inside the box rather than at
// the very tip, where an arrowhead or origin circle already sits.
const SLASH_LEN = 11;
const SLASH_INSET = 9;

// An ELK edge that may carry a caption. elkjs types edges structurally; this narrows
// what a label writer needs to touch. The diagram style fills `labels` (measuring the
// text in its own font); the engine just hands it the edge.
export interface LabelableEdge {
  id: string;
  labels?: {
    id: string;
    text: string;
    width: number;
    height: number;
    layoutOptions?: Record<string, string>;
  }[];
}

// How to draw one connection: its arrowhead end and its resolved stroke color
// (undefined = fall back to the theme line color via CSS). The remaining flags are
// the drawn VARIANTS a diagram style may ask for; a style that wants none simply
// leaves them unset.
//
// `text` marks a line to a text annotation. It carries no look of its own — it gates
// the ROUTING path (the engine draws such a line as one straight border-to-border
// segment instead of routing it, see addConnections). A style that would rather route
// its annotation lines leaves this false and picks a look below.
//
// `messageFlow` is a connection crossing a swimlane boundary (a BPMN message flow):
// dashed, with a hollow (background-filled, outlined) arrowhead and a small open
// circle at its ORIGIN end. `circle` says which end of THIS drawn edge carries that
// origin circle — a whole-line edge, or the one segment of a multi-segment route that
// touches the origin; undefined on every other edge/segment of the line.
//
// `dataAssoc` is a connection touching a data element or annotation (a BPMN data
// association): dotted, with an open (line-only) "V" arrowhead. It takes priority
// over `messageFlow`, so the two never both apply.
//
// `slashStart`/`slashEnd` draw a short diagonal tick across this edge's start/end
// point (BPMN's default-sequence-flow marker when it sits at the source). A polyline
// is drawn source-point-first, so on a whole-line edge `slashStart` is the source end
// and `slashEnd` the target end; a multi-segment route redistributes them onto the
// segment that touches each end (see applyManualRoute).
export interface ConnStyle {
  arrow: ArrowEnd;
  text: boolean;
  stroke?: string;
  messageFlow?: boolean;
  dataAssoc?: boolean;
  circle?: 'start' | 'end';
  slashStart?: boolean;
  slashEnd?: boolean;
}

// The hand-drawn bridge for a boundary-crossing line whose port chains stop short
// of a common parent. It connects the two outermost anchors — `from` on the source
// side, `to` on the target side. `style.arrow` is already resolved (it only carries
// a head when the bridge itself touches an endpoint). `bend` shapes it.
export interface ManualEdge {
  from: Anchor;
  to: Anchor;
  style: ConnStyle;
  // Resolved by planRoute (never undefined) — `auto` when no explicit shape.
  bend: 'z' | 'n' | 'l' | 'auto';
  // Resolved exit/enter sides — shape an `l` and let `auto` detect the 90° case.
  exitSide?: Side;
  enterSide?: Side;
  // The line's caption, when this bridge is the segment nearest the source and no
  // ELK edge could carry the label (a pure hand-drawn crossing).
  label?: string;
}

// A straight-by-default line: DRAWN as a single segment between its two boxes
// (border to border), never following ELK's bends. Endpoints are node ids.
export interface StraightEdge {
  sourceId: string;
  targetId: string;
  style: ConnStyle;
  label?: string;
}

interface ElkEdgeSection {
  startPoint: { x: number; y: number };
  endPoint: { x: number; y: number };
  bendPoints?: { x: number; y: number }[];
}
// A laid-out edge label: ELK reports its box in the edge's container coordinates
// (the same frame as the section points), so the draw pass adds the accumulated
// origin to place it.
interface LaidEdgeLabel {
  text?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}
interface LaidEdge {
  id: string;
  sections?: ElkEdgeSection[];
  labels?: LaidEdgeLabel[];
}

// The line-end markers for one diagram. `valid` is the shared CSS-colored default;
// the factories mint (and cache) a marker painted with a specific stroke color,
// since a marker can't inherit the referencing line's color cross-browser. All ids
// are scoped by the svg id so diagrams on one page don't collide.
export interface Markers {
  valid: string;
  forColor(color: string): string;
  // A message flow's hollow (background-filled, outlined) arrowhead and its open
  // origin circle. `color` overrides the outline (a line with an explicit stroke);
  // undefined uses the theme line color. Both are cached per color.
  messageEnd(color?: string): string;
  messageStart(color?: string): string;
  // A data association's open "V" arrowhead (line-only, no fill), colored the same way.
  dataArrow(color?: string): string;
}

// Creates the <defs>, the default arrowhead marker, and the color/variant marker
// factories. `theme` supplies the line and background colors the message markers paint
// with (their fill is the background, their outline the line color) — these can't be
// class-driven, since a hollow head must positively paint over whatever sits beneath it.
export function createMarkers(
  svg: SVGSVGElement,
  id: string,
  theme: { line: string; background: string },
): Markers {
  const defs = svgEl('defs', {});
  svg.appendChild(defs);
  const valid = `bpmn-arrow-${id}`;
  defs.appendChild(arrowMarker(valid, 'bpmn-arrow'));

  let n = 0;
  // One per-color cache per factory, keyed by a prefix so the four never collide.
  const caches = new Map<string, Map<string, string>>();
  const cached = (
    prefix: string,
    color: string | undefined,
    build: (markerId: string) => SVGElement,
  ): string => {
    const key = color ?? '';
    const cache = caches.get(prefix) ?? new Map<string, string>();
    caches.set(prefix, cache);
    const hit = cache.get(key);
    if (hit) return hit;
    const markerId = `${valid}-${prefix}${n++}`;
    defs.appendChild(build(markerId));
    cache.set(key, markerId);
    return markerId;
  };
  return {
    valid,
    forColor(color: string): string {
      return cached('c', color, (markerId) => {
        const marker = arrowMarker(markerId, 'bpmn-arrow');
        // Override the CSS fill so the arrowhead matches the custom line color.
        (marker.firstChild as SVGElement).setAttribute('style', `fill:${color}`);
        return marker;
      });
    },
    messageEnd(color?: string): string {
      return cached('m', color, (markerId) =>
        hollowArrowMarker(markerId, theme.background, color ?? theme.line),
      );
    },
    messageStart(color?: string): string {
      return cached('o', color, (markerId) =>
        circleMarker(markerId, theme.background, color ?? theme.line),
      );
    },
    dataArrow(color?: string): string {
      return cached('d', color, (markerId) => openArrowMarker(markerId, color ?? theme.line));
    },
  };
}

// Adjusts a drawn point list in place before it is painted — the hook a diagram
// style uses to pull endpoints onto a shape ELK does not know about (a gateway is
// laid out as a box but drawn as the diamond inscribed in it, so an endpoint on the
// box border has to be clipped in to the diamond edge). Optional: no hook means the
// ELK-reported points are drawn as-is.
export type ClipEnds = (points: Pt[]) => void;

// Draws the connection polylines, threading the same accumulated (ox, oy) the
// node pass uses so an edge's container-relative points land in absolute space.
// Only edges present in `styles` are real connections; the invisible ordering
// edges share the same arrays and are skipped.
export function drawEdges(
  svg: SVGSVGElement,
  node: ElkNode,
  ox: number,
  oy: number,
  styles: Map<string, ConnStyle>,
  markers: Markers,
  clip?: ClipEnds,
): void {
  const originX = ox + (node.x ?? 0);
  const originY = oy + (node.y ?? 0);

  for (const edge of (node.edges ?? []) as LaidEdge[]) {
    const style = styles.get(edge.id);
    if (!style) continue;
    const section = edge.sections?.[0];
    if (!section) continue;

    const points = [section.startPoint, ...(section.bendPoints ?? []), section.endPoint].map(
      (p) => ({ x: originX + p.x, y: originY + p.y }),
    );
    clip?.(points);
    drawEdgePolyline(svg, points, style, markers);
    // A caption ELK laid out on this edge (see applyEdgeLabel): drawn centred in the
    // box ELK reserved for it, in the same origin frame as the section points above.
    for (const lbl of edge.labels ?? []) {
      if (!lbl.text) continue;
      drawEdgeLabel(
        svg,
        originX + (lbl.x ?? 0) + (lbl.width ?? 0) / 2,
        originY + (lbl.y ?? 0) + (lbl.height ?? 0) / 2,
        lbl.text,
      );
    }
  }

  for (const child of node.children ?? []) {
    drawEdges(svg, child, originX, originY, styles, markers, clip);
  }
}

// Draws one connection as a rounded `path`: the `bpmn-edge` class plus the variant
// the style asked for, an inline stroke override when the line carries a color, and
// the matching head marker. Shared by ELK-routed and hand-routed edges. Corners are
// rounded (see roundedPath) with the radius clamped per corner, so a tight S-bend
// curves smoothly instead of overshooting.
export function drawEdgePolyline(
  svg: SVGSVGElement,
  points: Pt[],
  style: ConnStyle,
  markers: Markers,
): void {
  // The data association (dotted) wins over the message flow (dashed); otherwise
  // the plain edge.
  const cls = style.dataAssoc
    ? 'bpmn-edge bpmn-data-assoc'
    : style.messageFlow
      ? 'bpmn-edge bpmn-message-flow'
      : 'bpmn-edge';
  const shaped = diagonalizeSteps(points, LINE_CORNER_RADIUS);
  const line = svgEl('path', { d: roundedPath(shaped, LINE_CORNER_RADIUS), class: cls });
  if (style.stroke) line.setAttribute('style', `stroke:${style.stroke}`);

  const arrowId = style.dataAssoc
    ? markers.dataArrow(style.stroke)
    : style.messageFlow
      ? markers.messageEnd(style.stroke)
      : style.stroke
        ? markers.forColor(style.stroke)
        : markers.valid;
  if (style.arrow === 'end') line.setAttribute('marker-end', `url(#${arrowId})`);
  if (style.arrow === 'start') line.setAttribute('marker-start', `url(#${arrowId})`);

  // A message flow's origin circle sits on the end opposite the arrowhead (see
  // ConnStyle.circle — the caller picked the end, and the segment, it belongs on).
  if (style.messageFlow && style.circle) {
    const circleId = markers.messageStart(style.stroke);
    const end = style.circle === 'start' ? 'marker-start' : 'marker-end';
    line.setAttribute(end, `url(#${circleId})`);
  }
  svg.appendChild(line);

  // Slash ticks are drawn as their own short <line>s rather than SVG markers, so they
  // never contend with the arrowhead / origin circle for the same end, and so their
  // 45° angle can be taken from the polyline's own first/last run. `shaped` runs
  // source-point-first, so its start is `slashStart` and its end `slashEnd`.
  if ((style.slashStart || style.slashEnd) && shaped.length >= 2) {
    const n = shaped.length;
    if (style.slashStart) svg.appendChild(slashMark(shaped[0], shaped[1], style.stroke));
    if (style.slashEnd) svg.appendChild(slashMark(shaped[n - 1], shaped[n - 2], style.stroke));
  }
}

// A short diagonal tick across a line end (BPMN's default-sequence-flow marker when
// it sits at the source). `end` is the endpoint the tick sits near; `inward` the next
// polyline point, which gives the flow direction. The tick's centre is set
// SLASH_INSET inside the endpoint and its own direction is the flow rotated 45°, so
// it reads as a slash crossing the line.
function slashMark(end: Pt, inward: Pt, stroke?: string): SVGLineElement {
  const dx = inward.x - end.x;
  const dy = inward.y - end.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const cx = end.x + ux * SLASH_INSET;
  const cy = end.y + uy * SLASH_INSET;
  // The flow direction rotated +45° (cos45 = sin45 = SQRT1_2).
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

// Draws a line's caption at (`x`, `y`) with a transparent background — SVG text
// draws none, which is the whole "transparent label background" requirement.
// `anchor` aligns it horizontally about `x`. Multi-line labels stack as centred rows.
function drawEdgeLabel(svg: SVGSVGElement, x: number, y: number, text: string, anchor = 'middle'): void {
  svg.appendChild(captionText(text, x, LINE_LABEL_CLASS, LABEL_LINE_H, y, anchor));
}

// Places a caption near the SOURCE end of a HAND-DRAWN polyline (a bridge or a
// straight comment line — neither is an ELK edge, so ELK can't lay its label out).
// It sits a short way along the first segment from the source, nudged clear of the
// line: above a horizontal-ish run, to the right of a vertical-ish one.
export function drawLineLabelNearSource(svg: SVGSVGElement, points: Pt[], text: string): void {
  if (points.length === 0) return;
  const a = points[0];
  const b = points[1] ?? { x: a.x + 1, y: a.y };
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  // In from the source, but never past the segment's midpoint (a short stub keeps
  // the label near the source rather than sliding to the far box).
  const inset = Math.min(LINE_LABEL_INSET, len / 2);
  const ax = a.x + (dx / len) * inset;
  const ay = a.y + (dy / len) * inset;
  const half = captionHeight(text, LABEL_LINE_H) / 2;
  if (Math.abs(dx) >= Math.abs(dy)) {
    drawEdgeLabel(svg, ax, ay - LINE_LABEL_GAP - half, text); // above the line
  } else {
    drawEdgeLabel(svg, ax + LINE_LABEL_GAP, ay, text, 'start'); // beside the line
  }
}

// Records every node's absolute box by threading the accumulated offset down the
// laid-out tree, so hand-routed edges can find their endpoints' positions. Port
// positions (relative to their owning node) are resolved to absolute points in
// the same walk, so a bridge can start from a laid-out port.
export function collectAbsRects(
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

// Draws a straight-by-default line (see StraightEdge): a single segment from the
// source box's border to the target box's border, along the line joining their
// centres. Missing rects (an endpoint that never laid out) are skipped.
export function drawStraightEdge(
  svg: SVGSVGElement,
  edge: StraightEdge,
  rects: Map<string, AbsRect>,
  markers: Markers,
  clip?: ClipEnds,
): void {
  const s = rects.get(edge.sourceId);
  const t = rects.get(edge.targetId);
  if (!s || !t) return;
  const sc = { x: s.x + s.w / 2, y: s.y + s.h / 2 };
  const tc = { x: t.x + t.w / 2, y: t.y + t.h / 2 };
  const points = [borderPoint(s, tc), borderPoint(t, sc)];
  clip?.(points);
  drawEdgePolyline(svg, points, edge.style, markers);
  if (edge.label) drawLineLabelNearSource(svg, points, edge.label);
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
  // Triangle with tip at (10,5); the base (backside) curves inward toward the
  // tip rather than running straight, giving the head a slightly notched look.
  marker.appendChild(svgEl('path', { d: 'M0,0 L10,5 L0,10 Q3,5 0,0 z', class: className }));
  return marker;
}

// A message flow's hollow arrowhead: the same notched triangle as the solid arrow,
// but filled with the background and outlined in the line color, so it reads as an
// open head over whatever it sits on. Colors are inlined, not class-driven — the fill
// has to positively paint the background over the shape beneath it.
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

// A data association's open "V" arrowhead: two strokes meeting at the tip, left
// unclosed so there is nothing to fill. Stroked in the line color.
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
