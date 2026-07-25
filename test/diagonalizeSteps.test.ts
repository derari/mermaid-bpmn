import { describe, expect, it } from 'vitest';
import { diagonalizeSteps } from '../src/renderer.js';

// Unit tests for the narrow-S → diagonal rewrite. At r=10 the jog threshold is
// maxJog = 2*r = 20 and the setback targets r=10, clamped by the run it eats into
// and by the 20° minimum-angle floor.
const R = 10;
const MIN_ANGLE = (20 * Math.PI) / 180;

describe('diagonalizeSteps', () => {
  it('leaves a straight run untouched', () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 20, y: 0 },
      { x: 30, y: 0 },
    ];
    expect(diagonalizeSteps(pts, R)).toEqual(pts);
  });

  it('leaves a plain L-turn untouched', () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 20 },
      { x: 20, y: 40 },
    ];
    expect(diagonalizeSteps(pts, R)).toEqual(pts);
  });

  it('leaves a wide S-bend untouched (jog ≥ 2·radius keeps two 90° corners)', () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 30, y: 0 },
      { x: 30, y: 25 }, // 25px jog ≥ maxJog(20)
      { x: 60, y: 25 },
    ];
    expect(diagonalizeSteps(pts, R)).toEqual(pts);
  });

  it('leaves a U-turn untouched (opposite-direction runs are not a step)', () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 30, y: 0 },
      { x: 30, y: 10 },
      { x: 0, y: 10 },
    ];
    expect(diagonalizeSteps(pts, R)).toEqual(pts);
  });

  it('rewrites a narrow step into a diagonal between perpendicular stubs', () => {
    // 40px terminal runs, a 10px jog: each side backs off the full radius, leaving
    // a horizontal stub then a diagonal lane change.
    const out = diagonalizeSteps(
      [
        { x: 0, y: 0 },
        { x: 40, y: 0 },
        { x: 40, y: 10 },
        { x: 80, y: 10 },
      ],
      R,
    );
    expect(out).toEqual([
      { x: 0, y: 0 },
      { x: 30, y: 0 },
      { x: 50, y: 10 },
      { x: 80, y: 10 },
    ]);
  });

  it('holds the 20° floor on a tiny jog (setbacks scale down together)', () => {
    // A 2px jog would give a near-flat ramp; the spread is capped at jog/tan(20°).
    const out = diagonalizeSteps(
      [
        { x: 0, y: 0 },
        { x: 40, y: 0 },
        { x: 40, y: 2 },
        { x: 80, y: 2 },
      ],
      R,
    );
    const spread = out[2].x - out[1].x;
    const jog = 2;
    expect(spread).toBeCloseTo(jog / Math.tan(MIN_ANGLE), 5);
    // The diagonal itself sits at exactly the minimum angle.
    expect(Math.atan2(jog, spread)).toBeCloseTo(MIN_ANGLE, 5);
  });

  it('keeps a short terminal run fully perpendicular (setback 0)', () => {
    // A 5px terminal run is shorter than the radius, so it reserves 0 setback and
    // stays a 90° stub; only the opposite (long) side diagonalizes.
    const out = diagonalizeSteps(
      [
        { x: 0, y: 0 },
        { x: 5, y: 0 },
        { x: 5, y: 10 },
        { x: 45, y: 10 },
      ],
      R,
    );
    expect(out[1]).toEqual({ x: 5, y: 0 }); // unchanged: setback 0
  });

  it('reserves a full radius of perpendicular run on an 11px terminal run', () => {
    // avail = 11 - radius = 1, so the setback is 1px and 10px (the radius) stays
    // perpendicular before the curve.
    const out = diagonalizeSteps(
      [
        { x: 0, y: 0 },
        { x: 11, y: 0 },
        { x: 11, y: 10 },
        { x: 51, y: 10 },
      ],
      R,
    );
    expect(out[1].x).toBeCloseTo(10, 5); // 11 - 1 setback
  });

  it('caps an interior run at half its length', () => {
    // The step's in-run is interior (10px) so only half (5px) is available for the
    // setback, less than the radius.
    const out = diagonalizeSteps(
      [
        { x: 0, y: 0 },
        { x: 20, y: 0 },
        { x: 30, y: 0 }, // interior in-run: 10px
        { x: 30, y: 10 },
        { x: 40, y: 10 }, // interior out-run: 10px
        { x: 60, y: 10 },
      ],
      R,
    );
    expect(out[2]).toEqual({ x: 25, y: 0 }); // 30 - 5 (half of 10)
    expect(out[3]).toEqual({ x: 35, y: 10 }); // 30 + 5
  });
});
