import { describe, expect, it } from 'vitest';
import { diagonalizeSteps } from '../src/layout/geometry.js';

type Pt = { x: number; y: number };

const R = 10; // matches LINE_CORNER_RADIUS

// Angle (degrees) of the segment p→q against the horizontal, folded into [0,90].
function angleDeg(p: Pt, q: Pt): number {
  const a = (Math.atan2(Math.abs(q.y - p.y), Math.abs(q.x - p.x)) * 180) / Math.PI;
  return a;
}
const isH = (p: Pt, q: Pt): boolean => Math.abs(p.y - q.y) < 1e-6;
const isV = (p: Pt, q: Pt): boolean => Math.abs(p.x - q.x) < 1e-6;

describe('diagonalizeSteps', () => {
  it('leaves short paths and single corners untouched', () => {
    const straight = [{ x: 0, y: 0 }, { x: 50, y: 0 }];
    expect(diagonalizeSteps(straight, R)).toEqual(straight);
    const ell = [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }];
    expect(diagonalizeSteps(ell, R)).toEqual(ell); // one 90° turn, not a step
  });

  it('leaves a wide S-bend alone (jog ≥ 2·radius fits two plain corners)', () => {
    // jog of 40 (≥ 20) between two long horizontal runs: not narrow, no diagonal.
    const wide = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 40 },
      { x: 200, y: 40 },
    ];
    expect(diagonalizeSteps(wide, R)).toEqual(wide);
  });

  it('leaves a U-turn alone (runs face opposite ways)', () => {
    // a→v goes +x, w→b goes −x: a hairpin, not a lane-changing step.
    const u = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 8 },
      { x: 0, y: 8 },
    ];
    expect(diagonalizeSteps(u, R)).toEqual(u);
  });

  it('replaces a narrow step with a diagonal between two square stubs', () => {
    // Long runs (100), narrow jog (8 < 20). Terminal runs → setback = radius = 10.
    const step = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 8 },
      { x: 200, y: 8 },
    ];
    const out = diagonalizeSteps(step, R);
    // Endpoints preserved; the two jog vertices become two diagonal anchors.
    expect(out).toHaveLength(4);
    expect(out[0]).toEqual({ x: 0, y: 0 });
    expect(out[3]).toEqual({ x: 200, y: 8 });
    // Setback of 10 back along each terminal run (jog 8 → angle atan(8/20) ≈ 21.8°,
    // which clears the 20° floor, so the full radius setback is kept).
    expect(out[1]).toEqual({ x: 90, y: 0 });
    expect(out[2]).toEqual({ x: 110, y: 8 });
    // First/last pixels leave horizontally (square box exit); the middle is diagonal.
    expect(isH(out[0], out[1])).toBe(true);
    expect(isH(out[2], out[3])).toBe(true);
    expect(isH(out[1], out[2])).toBe(false);
    expect(isV(out[1], out[2])).toBe(false);
  });

  it('never lets the diagonal fall below the 20° minimum angle', () => {
    // Tiny jog (2) with long runs would give atan(2/20) ≈ 5.7°; the setback is
    // scaled back so the diagonal sits at exactly 20°.
    const step = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 2 },
      { x: 200, y: 2 },
    ];
    const out = diagonalizeSteps(step, R);
    expect(angleDeg(out[1], out[2])).toBeCloseTo(20, 5);
    // Still square at both ends.
    expect(isH(out[0], out[1])).toBe(true);
    expect(isH(out[2], out[3])).toBe(true);
  });

  it('keeps the whole terminal run perpendicular when it is shorter than the radius', () => {
    // Terminal run of 6 (< radius 10): there is no room to reserve a full radius and
    // still set back, so the setback is 0 — the whole 6px run stays a square exit and
    // only the far side bends into the diagonal.
    const step = [
      { x: 0, y: 0 },
      { x: 6, y: 0 },
      { x: 6, y: 8 },
      { x: 100, y: 8 },
    ];
    const out = diagonalizeSteps(step, R);
    // No setback on the short side: the anchor stays at the jog corner (6,0), so the
    // exit stays horizontal all the way to it.
    expect(out[1]).toEqual({ x: 6, y: 0 });
    expect(isH(out[0], out[1])).toBe(true);
    // The far (long) side still bends: its anchor is set back a full radius.
    expect(out[2]).toEqual({ x: 16, y: 8 });
  });

  it('reserves a corner radius of perpendicular run at a terminal exit', () => {
    // Terminal run of 11 (just over the radius): reserve radius (10) for the square
    // exit, leaving a 1px setback on that side; the anchor sits 1px back from the jog
    // so a 10px perpendicular stub precedes the curve.
    const step = [
      { x: 0, y: 0 },
      { x: 11, y: 0 },
      { x: 11, y: 8 },
      { x: 200, y: 8 },
    ];
    const out = diagonalizeSteps(step, R);
    expect(out[1]).toEqual({ x: 10, y: 0 }); // 10px square run before the diagonal
    expect(isH(out[0], out[1])).toBe(true);
  });

  it('shares an interior run (caps setback at half) so adjacent bends do not overrun', () => {
    // Here the step's first run (a→v) is interior — it does not start at pts[0] —
    // so its setback is capped at half its length (12/2 = 6), not the full radius.
    const pts = [
      { x: 0, y: 0 },
      { x: 0, y: -30 }, // leading segment → a=(0,-30) is interior for the step below
      { x: 12, y: -30 },
      { x: 12, y: -22 }, // jog of 8
      { x: 112, y: -22 },
    ];
    const out = diagonalizeSteps(pts, R);
    // Step is a=(0,-30) v=(12,-30) w=(12,-22) b=(112,-22): run a→v = 12 (interior),
    // so d0 = min(10, 6) = 6 → first anchor at x = 12 − 6 = 6.
    const anchor = out.find((p) => Math.abs(p.y - -30) < 1e-6 && p.x < 12 && p.x > 0);
    expect(anchor).toEqual({ x: 6, y: -30 });
  });
});
