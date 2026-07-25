import { describe, expect, it } from 'vitest';
import { orthogonalPoints } from '../src/renderer.js';

// Unit tests for the hand-drawn bridge shaper. The source box sits top-left, the
// target box bottom-right, so the two ends are more separated along x.
const s = { x: 0, y: 0, w: 100, h: 60 }; // centre (50, 30)
const t = { x: 300, y: 200, w: 100, h: 60 }; // centre (350, 230)

describe('orthogonalPoints', () => {
  it('z is a symmetric HVH (4 points, both ends on a vertical edge)', () => {
    expect(orthogonalPoints(s, t, 'z')).toEqual([
      { x: 100, y: 30 },
      { x: 200, y: 30 },
      { x: 200, y: 230 },
      { x: 300, y: 230 },
    ]);
  });

  it('n is a symmetric VHV (4 points, both ends on a horizontal edge)', () => {
    expect(orthogonalPoints(s, t, 'n')).toEqual([
      { x: 50, y: 60 },
      { x: 50, y: 130 },
      { x: 350, y: 130 },
      { x: 350, y: 200 },
    ]);
  });

  it('l with an e exit / n enter is a single HV corner off the source edge', () => {
    expect(orthogonalPoints(s, t, 'l', 'e', 'n')).toEqual([
      { x: 100, y: 30 }, // leaves the east edge
      { x: 350, y: 30 }, // one corner
      { x: 350, y: 200 }, // enters the north edge
    ]);
  });

  it('l with an s exit / w enter is a single VH corner off the source edge', () => {
    expect(orthogonalPoints(s, t, 'l', 's', 'w')).toEqual([
      { x: 50, y: 60 }, // leaves the south edge
      { x: 50, y: 230 }, // one corner
      { x: 300, y: 230 }, // enters the west edge
    ]);
  });

  it('auto picks l (a single corner) when exit and enter edges are perpendicular', () => {
    const pts = orthogonalPoints(s, t, 'auto', 'e', 'n');
    expect(pts).toHaveLength(3);
    expect(pts).toEqual([
      { x: 100, y: 30 },
      { x: 350, y: 30 },
      { x: 350, y: 200 },
    ]);
  });

  it('auto keeps the symmetric shape when exit and enter edges are parallel', () => {
    // e/w are both horizontal → not 90°, so it falls back to the axis-by-separation
    // HVH shape (x-separation dominates here).
    const pts = orthogonalPoints(s, t, 'auto', 'e', 'w');
    expect(pts).toHaveLength(4);
    expect(pts).toEqual(orthogonalPoints(s, t, 'z'));
  });

  it('an absent bend behaves like auto', () => {
    expect(orthogonalPoints(s, t, undefined, 'e', 'n')).toEqual(orthogonalPoints(s, t, 'auto', 'e', 'n'));
  });

  it('l without resolved sides falls back to the dominant-separation axis', () => {
    // x dominates → leaves east, turns down into the target's north edge.
    expect(orthogonalPoints(s, t, 'l')).toEqual([
      { x: 100, y: 30 },
      { x: 350, y: 30 },
      { x: 350, y: 200 },
    ]);
  });

  // A target far below the source (y-separation dominates): plain geometry auto
  // picks a VHV (n) shape.
  const below = { x: 200, y: 400, w: 100, h: 60 }; // centre (250, 430)

  it('auto uses box geometry (VHV here) when neither edge is fixed', () => {
    const pts = orthogonalPoints(s, below, 'auto', 'e', 'w', false, false);
    expect(pts).toEqual([
      { x: 50, y: 60 }, // leaves the south edge (vertical first)
      { x: 50, y: 230 },
      { x: 250, y: 230 },
      { x: 250, y: 400 },
    ]);
  });

  it('auto follows a fixed source edge (e → HVH) against the geometry', () => {
    // The source is a port pinned on the east (horizontal) edge, so despite the
    // dominant y-separation the line must leave horizontally → HVH (z).
    const pts = orthogonalPoints(s, below, 'auto', 'e', 'w', true, false);
    expect(pts).toEqual(orthogonalPoints(s, below, 'z'));
    expect(pts[0]).toEqual({ x: 100, y: 30 }); // leaves the east edge
  });

  it('auto follows a fixed target edge when the source is free', () => {
    // Target pinned on a vertical (n) edge, source free; x-separation dominates so
    // geometry alone would pick HVH, but the fixed target edge forces VHV (n).
    const right = { x: 400, y: 0, w: 100, h: 60 }; // centre (450, 30), x dominates
    const geom = orthogonalPoints(s, right, 'auto', undefined, undefined);
    expect(geom).toEqual(orthogonalPoints(s, right, 'z')); // geometry → HVH
    const fixed = orthogonalPoints(s, right, 'auto', undefined, 'n', false, true);
    expect(fixed).toEqual(orthogonalPoints(s, right, 'n')); // fixed edge → VHV
  });

  it('a fixed source edge takes precedence over a fixed target edge', () => {
    // Both parallel-horizontal fixed edges agree on HVH; the source is consulted first.
    const pts = orthogonalPoints(s, below, 'auto', 'e', 'w', true, true);
    expect(pts).toEqual(orthogonalPoints(s, below, 'z'));
  });
});
