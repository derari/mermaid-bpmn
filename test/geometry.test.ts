import type { ElkNode } from 'elkjs/lib/elk.bundled.js';
import { describe, expect, it } from 'vitest';
import {
  type Rect,
  capInset,
  childHalfExtent,
  commonAncestorId,
  partitionRegions,
  regionsStackVertically,
} from '../src/geometry.js';

// These cover the renderer's pure geometry helpers. The DOM + ELK drawing path is
// exercised visually in examples/ instead — headless it would depend on text
// measurement (getComputedTextLength is 0 without a real layout engine).

// A minimal laid-out container with the child boxes childHalfExtent reads.
const laid = (
  width: number,
  height: number,
  kids: { x: number; y: number; width: number; height: number }[],
): ElkNode => ({
  id: 'n',
  width,
  height,
  children: kids.map((k, i) => ({ id: `n.${i}`, ...k })),
});

describe('capInset', () => {
  // Padding needed so content of half-width hw clears a cap of radius r:
  // r - sqrt(r^2 - hw^2).
  it('needs no inset when content has no width', () => {
    expect(capInset(5, 0)).toBe(0);
  });

  it('follows the Pythagorean relation', () => {
    expect(capInset(5, 3)).toBeCloseTo(1); // 5 - sqrt(25-9) = 5 - 4
    expect(capInset(13, 5)).toBeCloseTo(1); // 13 - sqrt(169-25) = 13 - 12
  });

  it('insets the full radius when content spans the whole cap', () => {
    expect(capInset(5, 5)).toBeCloseTo(5);
  });

  it('clamps content wider than the cap rather than going NaN', () => {
    expect(capInset(5, 8)).toBeCloseTo(5);
  });
});

describe('childHalfExtent', () => {
  it('measures the widest horizontal reach from the mid-line', () => {
    // width 100 -> mid-line at x=50; a box spanning 24..104 reaches 54 past it.
    expect(childHalfExtent(laid(100, 200, [{ x: 24, y: 10, width: 80, height: 44 }]), true))
      .toBeCloseTo(54);
  });

  it('measures the vertical reach instead when the caps are left/right', () => {
    // height 100 -> mid-line at y=50; a box spanning 20..100 reaches 50 below it.
    expect(childHalfExtent(laid(200, 100, [{ x: 10, y: 20, width: 44, height: 80 }]), false))
      .toBeCloseTo(50);
  });

  it('takes the largest reach across several children', () => {
    const node = laid(120, 300, [
      { x: 40, y: 10, width: 40, height: 44 }, // reaches 20 past mid (60)
      { x: 10, y: 60, width: 100, height: 44 }, // reaches 50 past mid
    ]);
    expect(childHalfExtent(node, true)).toBeCloseTo(50);
  });

  it('is zero with no children', () => {
    expect(childHalfExtent(laid(100, 100, []), true)).toBe(0);
  });
});

describe('commonAncestorId', () => {
  it('is the root (empty) for nodes in different top-level trees', () => {
    expect(commonAncestorId('n0', 'n1')).toBe('');
    expect(commonAncestorId('n0.1', 'n1.0')).toBe('');
  });

  it('is the shared container for siblings deeper in the tree', () => {
    expect(commonAncestorId('n0.1', 'n0.2')).toBe('n0');
    expect(commonAncestorId('n0.1.0', 'n0.1.3')).toBe('n0.1');
  });

  it('is the ancestor itself when one node contains the other', () => {
    expect(commonAncestorId('n0.1', 'n0.1.2')).toBe('n0.1');
  });

  it('returns the id unchanged for a node paired with itself', () => {
    expect(commonAncestorId('n0.1', 'n0.1')).toBe('n0.1');
  });
});

describe('partitionRegions', () => {
  const interior: Rect = { x: 0, y: 0, w: 100, h: 100 };

  it('gives a lone region the whole interior', () => {
    const [r] = partitionRegions(interior, [{ x: 10, y: 10, w: 20, h: 20 }], true);
    expect(r).toEqual(interior);
  });

  it('splits vertically at the midpoint of the gap between two regions', () => {
    // Two stacked children: 0..30 and 50..90 -> boundary at (30+50)/2 = 40.
    const rects = partitionRegions(
      interior,
      [
        { x: 0, y: 0, w: 40, h: 30 },
        { x: 0, y: 50, w: 40, h: 40 },
      ],
      true,
    );
    expect(rects[0]).toEqual({ x: 0, y: 0, w: 100, h: 40 });
    expect(rects[1]).toEqual({ x: 0, y: 40, w: 100, h: 60 });
  });

  it('splits horizontally along the main axis when not vertical', () => {
    // Side-by-side children 0..40 and 60..100 -> boundary at 50.
    const rects = partitionRegions(
      interior,
      [
        { x: 0, y: 0, w: 40, h: 20 },
        { x: 60, y: 0, w: 40, h: 20 },
      ],
      false,
    );
    expect(rects[0]).toEqual({ x: 0, y: 0, w: 50, h: 100 });
    expect(rects[1]).toEqual({ x: 50, y: 0, w: 50, h: 100 });
  });

  it('tiles the interior edge to edge with no gaps or overlap', () => {
    const boxes: Rect[] = [
      { x: 0, y: 5, w: 40, h: 20 },
      { x: 0, y: 40, w: 40, h: 20 },
      { x: 0, y: 75, w: 40, h: 20 },
    ];
    const rects = partitionRegions(interior, boxes, true);
    expect(rects[0].y).toBe(0);
    expect(rects[2].y + rects[2].h).toBe(100);
    expect(rects[0].y + rects[0].h).toBe(rects[1].y);
    expect(rects[1].y + rects[1].h).toBe(rects[2].y);
  });

  it('returns rects in input order even when boxes are out of order', () => {
    const rects = partitionRegions(
      interior,
      [
        { x: 0, y: 60, w: 40, h: 30 }, // declared second in space, first in array
        { x: 0, y: 0, w: 40, h: 30 },
      ],
      true,
    );
    // rects[0] corresponds to the lower box, rects[1] to the upper one.
    expect(rects[0].y).toBeGreaterThan(rects[1].y);
  });

  it('is empty for no regions', () => {
    expect(partitionRegions(interior, [], true)).toEqual([]);
  });
});

describe('regionsStackVertically', () => {
  it('treats fewer than two boxes as vertical (axis irrelevant)', () => {
    expect(regionsStackVertically([])).toBe(true);
    expect(regionsStackVertically([{ x: 0, y: 0, w: 10, h: 10 }])).toBe(true);
  });

  it('is vertical when boxes spread further in y than x', () => {
    expect(
      regionsStackVertically([
        { x: 0, y: 0, w: 80, h: 44 },
        { x: 0, y: 120, w: 80, h: 44 },
      ]),
    ).toBe(true);
  });

  it('is horizontal when boxes spread further in x than y', () => {
    expect(
      regionsStackVertically([
        { x: 0, y: 0, w: 80, h: 44 },
        { x: 120, y: 0, w: 80, h: 44 },
      ]),
    ).toBe(false);
  });
});
