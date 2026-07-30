import { describe, expect, it } from 'vitest';
import { roundedPath } from '../src/layout/geometry.js';

// roundedPath turns an orthogonal point list into a path `d`, rounding every
// interior corner with the radius clamped per corner to half of each adjacent
// segment. The clamp is the whole point: a tight S-bend must curve smoothly
// instead of overshooting into a self-crossing loop.
describe('roundedPath', () => {
  it('emits a plain M/L path (no curve) for a straight two-point line', () => {
    expect(roundedPath([{ x: 0, y: 0 }, { x: 50, y: 0 }], 7)).toBe('M 0,0 L 50,0');
  });

  it('handles empty and single-point inputs', () => {
    expect(roundedPath([], 7)).toBe('');
    expect(roundedPath([{ x: 5, y: 5 }], 7)).toBe('M 5,5');
  });

  it('rounds a lone corner at the full radius when both segments are long', () => {
    // 100px stubs → t = min(7, 50, 50) = 7. Tangent points sit 7px back from the
    // vertex along each leg; the vertex itself is the quadratic control point.
    const d = roundedPath([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }], 7);
    expect(d).toBe('M 0,0 L 93,0 Q 100,0 100,7 L 100,100');
  });

  it('clamps a tight S-bend so the two arcs meet at the mid of the short run, never past it', () => {
    // Corners at (10,0) and (10,4) share a 4px middle segment. With radius 7 the
    // naive back-off would be 7px into a 4px run — each corner would overshoot the
    // other (to y=7 and y=-3, a crossing). Clamped: t = min(7, .../2) = 2 at both,
    // so the arcs meet exactly at (10,2), the segment's midpoint. No straight bit
    // is left over, and nothing overshoots.
    const d = roundedPath(
      [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 4 }, { x: 20, y: 4 }],
      7,
    );
    expect(d).toBe('M 0,0 L 8,0 Q 10,0 10,2 L 10,2 Q 10,4 12,4 L 20,4');

    // Every coordinate on the shared run stays within [0,4] — the proof there is
    // no overshoot beyond the midpoint.
    const ys = [...d.matchAll(/,(-?[\d.]+)/g)].map((m) => Number(m[1]));
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...ys)).toBeLessThanOrEqual(4);
  });

  it('drops a degenerate (zero-length) vertex instead of emitting a stub segment', () => {
    // A coincident consecutive point (e.g. two orthogonal corners collapsed onto one spot
    // once a bridge was aligned straight) is squeezed out, leaving a clean line — no curve,
    // no NaN, and no redundant `L x,y L x,y` stub.
    const d = roundedPath([{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 }], 7);
    expect(d).toBe('M 0,0 L 10,0');
    expect(d).not.toContain('Q');
    expect(d).not.toContain('NaN');
  });
});
