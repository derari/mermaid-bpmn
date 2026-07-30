// Orthogonal edge geometry: bend shapes and rounded/diagonalised paths. Pure and
// diagram-agnostic — it knows only points, boxes, and sides, never entity types.
// Shared by every drawn edge (ELK-routed and hand-drawn bridges alike).
import type { Side } from './model.js';

export const LINE_CORNER_RADIUS = 10; // corner radius for a connection's bends (clamped per corner)
// A narrow S-bend (two 90° corners joined by a short jog) is replaced by a single
// short diagonal so the line changes lanes smoothly instead of kinking. See
// diagonalizeSteps: the diagonal's setback targets the corner radius, is never
// shallower than DIAGONAL_MIN_ANGLE, and reserves a corner radius of perpendicular
// run at a line end so the line leaves a box square and then curves into the diagonal.
const DIAGONAL_MIN_ANGLE = (20 * Math.PI) / 180; // shallowest diagonal we allow (radians)

export type Pt = { x: number; y: number };

// A node's absolute box, or a zero-size port anchor (w = h = 0).
export interface AbsRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Where the ray from `rect`'s centre toward `toward` crosses the rect's border —
// the point a straight connector should touch it, so the line meets the box edge
// rather than overshooting to its centre. (A rounded box clips to its bounding
// rect, close enough for the short overhang the corner radius would trim.)
export function borderPoint(rect: AbsRect, toward: Pt): Pt {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const dx = toward.x - cx;
  const dy = toward.y - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const tx = dx !== 0 ? rect.w / 2 / Math.abs(dx) : Number.POSITIVE_INFINITY;
  const ty = dy !== 0 ? rect.h / 2 / Math.abs(dy) : Number.POSITIVE_INFINITY;
  const t = Math.min(tx, ty);
  return { x: cx + dx * t, y: cy + dy * t };
}

// Whether a side lies on the horizontal axis (a left/right edge) — its opposite,
// the vertical axis, is n/s. Used to read the "orientation" of an exit/enter side.
export function isHorizontalSide(side: Side): boolean {
  return side === 'e' || side === 'w';
}

// A single-corner L route: leave the source on its exit side, run straight to the
// target's other axis, turn once, and enter the target. The exit side's
// orientation picks the shape — a horizontal exit (e/w) gives HV (across, then
// up/down); a vertical exit (n/s) gives VH. With no exit side (unlikely for a
// bridge) it falls back to the axis the boxes are more separated along. A
// zero-size box (a port anchor) collapses to its single point on the shared axis.
function lPoints(s: AbsRect, t: AbsRect, exitSide?: Side): Pt[] {
  const scx = s.x + s.w / 2;
  const scy = s.y + s.h / 2;
  const tcx = t.x + t.w / 2;
  const tcy = t.y + t.h / 2;
  const horizontalFirst = exitSide
    ? isHorizontalSide(exitSide)
    : Math.abs(tcx - scx) >= Math.abs(tcy - scy);
  if (horizontalFirst) {
    // Out the e/w side at source height, across to the target's column, then
    // down/up into its n/s side. The corner sits at (tcx, scy).
    const sx = tcx >= scx ? s.x + s.w : s.x;
    const ty = tcy >= scy ? t.y : t.y + t.h;
    return [{ x: sx, y: scy }, { x: tcx, y: scy }, { x: tcx, y: ty }];
  }
  // Out the n/s side at source column, down/up to the target's row, then across
  // into its e/w side. The corner sits at (scx, tcy).
  const sy = tcy >= scy ? s.y + s.h : s.y;
  const tx = tcx >= scx ? t.x : t.x + t.w;
  return [{ x: scx, y: sy }, { x: scx, y: tcy }, { x: tx, y: tcy }];
}

// A simple orthogonal route between two boxes for an edge ELK didn't route: exit
// the source and enter the target on the facing sides, with the turn taken at
// the midpoint of the gap. `bend` fixes the shape — `n` = VHV (leave top/bottom),
// `z` = HVH (leave left/right), `l` = a single-corner turn shaped by the exit
// side; `auto` (the default — an omitted `bend` is treated identically) turns into
// an `l` when the exit and enter edges meet at 90° (perpendicular axes), so callers
// never have to distinguish undefined from `auto`. Otherwise it is an S-bend (Z or
// N), whose axis —
// like the `l` — follows a KNOWN exit/enter side when there is one (an e/w edge
// wants HVH, an n/s edge VHV), so the line leaves the box on the side the routing
// picked; only with no side info does it fall back to the axis the boxes are more
// separated along. A zero-size source box routes from a single point (used for a
// port anchor). Exported for unit testing.
export function orthogonalPoints(
  s: AbsRect,
  t: AbsRect,
  bend: 'z' | 'n' | 'l' | 'auto' = 'auto',
  exitSide?: Side,
  enterSide?: Side,
): Pt[] {
  // `auto` becomes an `l` exactly when the two edges are perpendicular: a facing
  // (opposite) or same-side pair still wants the two-corner S below. An omitted
  // `bend` defaulted to `auto` above, so undefined and `auto` are one case here.
  const perpendicular =
    !!exitSide && !!enterSide && isHorizontalSide(exitSide) !== isHorizontalSide(enterSide);
  const shape = bend === 'auto' && perpendicular ? 'l' : bend;
  if (shape === 'l') return lPoints(s, t, exitSide);

  const scx = s.x + s.w / 2;
  const scy = s.y + s.h / 2;
  const tcx = t.x + t.w / 2;
  const tcy = t.y + t.h / 2;
  // When either edge is fixed (a port, or an auto/explicit exit/enter side) both
  // sit on the same axis here (the perpendicular case already became an `l`), so
  // that axis decides Z vs N — mirroring how `l` reads the exit side. Only a bend
  // with no side at all falls back to the box-center angle.
  const knownSide = exitSide ?? enterSide;
  const verticalFirst =
    shape === 'n'
      ? true
      : shape === 'z'
        ? false
        : knownSide !== undefined
          ? !isHorizontalSide(knownSide)
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

// Whether a→v→w→b is a "step": two parallel, same-direction runs (a→v and w→b)
// joined by a short perpendicular jog (v→w) below `maxJog`. This is the narrow
// S-bend a diagonal smooths; an L-turn (one corner) or a U-turn (runs facing
// opposite ways) is not a step and is left alone. Axis-alignment is tested with a
// small epsilon since ELK coordinates are floats.
function isStep(a: Pt, v: Pt, w: Pt, b: Pt, maxJog: number): boolean {
  const EPS = 1e-6;
  const av = { x: v.x - a.x, y: v.y - a.y };
  const vw = { x: w.x - v.x, y: w.y - v.y };
  const wb = { x: b.x - w.x, y: b.y - w.y };
  const horiz = (p: Pt): boolean => Math.abs(p.y) < EPS && Math.abs(p.x) > EPS;
  const vert = (p: Pt): boolean => Math.abs(p.x) < EPS && Math.abs(p.y) > EPS;
  if (horiz(av) && horiz(wb) && vert(vw)) {
    return Math.sign(av.x) === Math.sign(wb.x) && Math.abs(vw.y) < maxJog;
  }
  if (vert(av) && vert(wb) && horiz(vw)) {
    return Math.sign(av.y) === Math.sign(wb.y) && Math.abs(vw.x) < maxJog;
  }
  return false;
}

// Rewrites every narrow step in an orthogonal point list into a short diagonal,
// so a tight S-bend reads as a single lane-change rather than a rounded kink. For
// each step, the diagonal starts `d` back along one run and ends `d` along the
// next; `d` targets the corner radius but is clamped three ways:
//   - to the run it sits on — a terminal run (a line end) keeps only a PERP_STUB
//     so the box exit stays square ("the first pixel is a right angle"); an
//     interior run is shared with a neighbouring corner, so it yields at most half;
//   - so the diagonal is never shallower than DIAGONAL_MIN_ANGLE (a near-flat ramp
//     reads as a wobble): the total run-back is capped at jog / tan(minAngle).
// roundedPath then rounds the two shallower corners exactly as it does any others,
// so no new curve maths is needed. Shared by every edge — hand-routed and ELK.
export function diagonalizeSteps(pts: Pt[], radius: number): Pt[] {
  if (pts.length < 4) return pts;
  const maxJog = 2 * radius; // above this, two plain rounded 90° corners fit fine
  const minAngleTan = Math.tan(DIAGONAL_MIN_ANGLE);
  const out: Pt[] = [pts[0]];
  let i = 1;
  while (i < pts.length - 1) {
    const a = pts[i - 1];
    const v = pts[i];
    const w = pts[i + 1];
    const b = pts[i + 2] as Pt | undefined;
    if (!b || !isStep(a, v, w, b, maxJog)) {
      out.push(v);
      i++;
      continue;
    }
    const jog = Math.hypot(w.x - v.x, w.y - v.y);
    const runA = Math.hypot(v.x - a.x, v.y - a.y);
    const runB = Math.hypot(b.x - w.x, b.y - w.y);
    // A run that ends at the whole line's start/end keeps a square exit: reserve a
    // full corner radius of perpendicular run before the diagonal, so the line
    // leaves the box at 90° and then curves in (rather than shooting off at an
    // angle). An interior run is shared with its other corner, so it yields at most
    // half. When a terminal run is shorter than the radius the whole run is kept
    // perpendicular (setback 0) and only the far side bends into the diagonal.
    const availA = i - 1 === 0 ? Math.max(0, runA - radius) : runA / 2;
    const availB = i + 2 === pts.length - 1 ? Math.max(0, runB - radius) : runB / 2;
    let d0 = Math.min(radius, availA);
    let d1 = Math.min(radius, availB);
    // Keep the diagonal at least DIAGONAL_MIN_ANGLE: its horizontal spread (d0+d1)
    // may be at most jog / tan(minAngle); scale both back together if it exceeds it.
    const maxTotal = jog / minAngleTan;
    const total = d0 + d1;
    if (total > maxTotal && total > 0) {
      const k = maxTotal / total;
      d0 *= k;
      d1 *= k;
    }
    const uA = { x: (v.x - a.x) / runA, y: (v.y - a.y) / runA };
    const uB = { x: (b.x - w.x) / runB, y: (b.y - w.y) / runB };
    out.push({ x: v.x - d0 * uA.x, y: v.y - d0 * uA.y });
    out.push({ x: w.x + d1 * uB.x, y: w.y + d1 * uB.y });
    i += 2; // both jog vertices consumed
  }
  for (; i < pts.length; i++) out.push(pts[i]);
  return out;
}

// Builds an SVG path `d` for an orthogonal point list, rounding every interior
// corner. Each vertex is replaced by a quadratic curve: back off `t` along both
// incident segments to the tangent points, then arc through the vertex. `t` is
// clamped to half of each adjacent segment (`min(radius, in/2, out/2)`), so when
// a segment is shared by two corners — the short middle run of a tight S-bend —
// neither corner can eat past its midpoint. The two arcs meet cleanly instead of
// overshooting into a self-crossing loop, and a stub can never round past its own
// endpoint (so heads/box edges stay attached). Collinear or zero-length vertices
// pass straight through. Exported for unit testing (the clamp behaviour on tight bends).
export function roundedPath(ptsIn: Pt[], radius: number): string {
  // Drop consecutive coincident points first. A straight (axis-aligned) polyline can carry
  // a zero-length leg — two orthogonal corners that collapsed onto the same point, e.g. a
  // wrapper bridge whose ends were aligned onto one row. Left in, it renders as a degenerate
  // `L x,y L x,y`; removing it changes nothing visually and keeps the path clean.
  const EPS = 1e-6;
  const pts: Pt[] = [];
  for (const p of ptsIn) {
    const last = pts[pts.length - 1];
    if (!last || Math.abs(last.x - p.x) > EPS || Math.abs(last.y - p.y) > EPS) pts.push(p);
  }
  if (pts.length === 0) return '';
  if (pts.length < 3) return `M ${pts.map((p) => `${p.x},${p.y}`).join(' L ')}`;

  let d = `M ${pts[0].x},${pts[0].y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1];
    const v = pts[i];
    const b = pts[i + 1];
    const din = Math.hypot(v.x - a.x, v.y - a.y);
    const dout = Math.hypot(b.x - v.x, b.y - v.y);
    if (din === 0 || dout === 0) {
      d += ` L ${v.x},${v.y}`;
      continue;
    }
    const t = Math.min(radius, din / 2, dout / 2);
    const inx = v.x - (t * (v.x - a.x)) / din;
    const iny = v.y - (t * (v.y - a.y)) / din;
    const outx = v.x + (t * (b.x - v.x)) / dout;
    const outy = v.y + (t * (b.y - v.y)) / dout;
    d += ` L ${inx},${iny} Q ${v.x},${v.y} ${outx},${outy}`;
  }
  const last = pts[pts.length - 1];
  d += ` L ${last.x},${last.y}`;
  return d;
}
