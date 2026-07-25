import { describe, expect, it } from 'vitest';
import { roundedPath } from '../src/renderer.js';

// Unit tests for the pure SVG-path builder. It rounds each interior corner with a
// quadratic, backing off min(radius, din/2, dout/2) along both incident segments,
// and leaves endpoints (and zero-length/collinear vertices) untouched.

describe('roundedPath', () => {
  it('emits a plain line for a straight two-point run (no corners to round)', () => {
    expect(roundedPath([{ x: 0, y: 0 }, { x: 10, y: 0 }], 10)).toBe('M0,0 L10,0');
  });

  it('handles empty and single-point inputs', () => {
    expect(roundedPath([], 10)).toBe('');
    expect(roundedPath([{ x: 5, y: 5 }], 10)).toBe('M5,5');
  });

  it('rounds a lone corner at the full radius when both segments are long', () => {
    // L-shape with 100px legs at r=10: back off 10 along each, then a quadratic
    // through the vertex.
    const d = roundedPath([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }], 10);
    expect(d).toBe('M0,0 L90,0 Q100,0 100,10 L100,100');
  });

  it('clamps a tight-S so the two arcs meet at the shared run midpoint (no overshoot)', () => {
    // The middle run is only 4px, shared by two corners at r=10. Each corner is
    // clamped to half the run (2px), so the arcs meet exactly at x=2 (the midpoint)
    // instead of eating past each other into a self-crossing loop.
    const d = roundedPath(
      [
        { x: 0, y: 0 },
        { x: 0, y: 10 },
        { x: 4, y: 10 },
        { x: 4, y: 20 },
      ],
      10,
    );
    expect(d).toBe('M0,0 L0,8 Q0,10 2,10 L2,10 Q4,10 4,12 L4,20');
  });

  it('passes a degenerate zero-length vertex straight through (no quadratic)', () => {
    const d = roundedPath(
      [
        { x: 0, y: 0 },
        { x: 5, y: 0 },
        { x: 5, y: 0 },
        { x: 10, y: 0 },
      ],
      10,
    );
    expect(d).toBe('M0,0 L5,0 L5,0 L10,0');
    expect(d).not.toContain('Q');
  });
});
