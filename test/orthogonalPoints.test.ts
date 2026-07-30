import { describe, expect, it } from 'vitest';
import { type AbsRect, orthogonalPoints } from '../src/layout/geometry.js';

type Pt = { x: number; y: number };

const isH = (p: Pt, q: Pt): boolean => Math.abs(p.y - q.y) < 1e-6 && Math.abs(p.x - q.x) > 1e-6;
const isV = (p: Pt, q: Pt): boolean => Math.abs(p.x - q.x) < 1e-6 && Math.abs(p.y - q.y) > 1e-6;

// The source box sits top-left, the target box down-and-right of it, so the two
// are separated on both axes (a diagonal offset) — the case where an L reads best.
const S: AbsRect = { x: 0, y: 0, w: 40, h: 40 };
const T: AbsRect = { x: 200, y: 200, w: 40, h: 40 };

describe('orthogonalPoints — z/n/auto S-bends', () => {
  it('z leaves left/right (HVH): two horizontal ends, four points', () => {
    const p = orthogonalPoints(S, T, 'z');
    expect(p).toHaveLength(4);
    expect(isH(p[0], p[1])).toBe(true);
    expect(isH(p[2], p[3])).toBe(true);
  });

  it('n leaves top/bottom (VHV): two vertical ends, four points', () => {
    const p = orthogonalPoints(S, T, 'n');
    expect(p).toHaveLength(4);
    expect(isV(p[0], p[1])).toBe(true);
    expect(isV(p[2], p[3])).toBe(true);
  });

  it('auto stays an S-bend when the edges face each other (opposite sides)', () => {
    // exit e / enter w are on the same (horizontal) axis → not 90° → no L.
    const p = orthogonalPoints(S, T, 'auto', 'e', 'w');
    expect(p).toHaveLength(4);
  });
});

describe('orthogonalPoints — l single-corner turns', () => {
  it('HV for a horizontal exit side (e): across, then down into the target', () => {
    const p = orthogonalPoints(S, T, 'l', 'e');
    expect(p).toHaveLength(3);
    expect(isH(p[0], p[1])).toBe(true); // leaves on the e side, running horizontally
    expect(isV(p[1], p[2])).toBe(true); // one corner, then vertical into the target
    // Leaves the source's right edge at source-center height; enters the target's
    // top at target-center column.
    expect(p[0]).toEqual({ x: 40, y: 20 });
    expect(p[2]).toEqual({ x: 220, y: 200 });
  });

  it('VH for a vertical exit side (s): down, then across into the target', () => {
    const p = orthogonalPoints(S, T, 'l', 's');
    expect(p).toHaveLength(3);
    expect(isV(p[0], p[1])).toBe(true);
    expect(isH(p[1], p[2])).toBe(true);
    expect(p[0]).toEqual({ x: 20, y: 40 }); // leaves the source's bottom edge
    expect(p[2]).toEqual({ x: 200, y: 220 }); // enters the target's left edge
  });
});

describe('orthogonalPoints — auto S-bend follows a fixed edge over the box angle', () => {
  // Boxes separated mostly HORIZONTALLY: the box-angle would pick a Z (HVH). But a
  // fixed VERTICAL edge (s/n, same axis so no L) must win → N (VHV), vertical ends.
  it('picks N (vertical ends) for vertical edges despite a horizontal gap', () => {
    const s: AbsRect = { x: 0, y: 0, w: 40, h: 40 };
    const t: AbsRect = { x: 400, y: 50, w: 40, h: 40 };
    const p = orthogonalPoints(s, t, 'auto', 's', 'n');
    expect(p).toHaveLength(4);
    expect(isV(p[0], p[1])).toBe(true);
    expect(isV(p[2], p[3])).toBe(true);
  });

  // Boxes separated mostly VERTICALLY: the box-angle would pick an N (VHV). But a
  // fixed HORIZONTAL edge (e/w) must win → Z (HVH), horizontal ends.
  it('picks Z (horizontal ends) for horizontal edges despite a vertical gap', () => {
    const s: AbsRect = { x: 0, y: 0, w: 40, h: 40 };
    const t: AbsRect = { x: 50, y: 400, w: 40, h: 40 };
    const p = orthogonalPoints(s, t, 'auto', 'e', 'w');
    expect(p).toHaveLength(4);
    expect(isH(p[0], p[1])).toBe(true);
    expect(isH(p[2], p[3])).toBe(true);
  });

  // One side alone is enough to fix the axis (the other end has no chain/port).
  it('follows a lone exit side when the enter side is unknown', () => {
    const s: AbsRect = { x: 0, y: 0, w: 40, h: 40 };
    const t: AbsRect = { x: 400, y: 50, w: 40, h: 40 };
    const p = orthogonalPoints(s, t, 'auto', 's');
    expect(p).toHaveLength(4);
    expect(isV(p[0], p[1])).toBe(true);
  });
});

describe('orthogonalPoints — auto picks l at 90°', () => {
  it('turns into an l when exit and enter axes are perpendicular', () => {
    // exit e (horizontal) + enter n (vertical) = 90° → single-corner L (HV).
    const p = orthogonalPoints(S, T, 'auto', 'e', 'n');
    expect(p).toHaveLength(3);
    expect(isH(p[0], p[1])).toBe(true);
    expect(isV(p[1], p[2])).toBe(true);
  });

  it('does not pick l without side info (plain geometric auto)', () => {
    const p = orthogonalPoints(S, T, 'auto');
    expect(p).toHaveLength(4);
  });
});
