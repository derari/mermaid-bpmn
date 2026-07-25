import type { ElkNode } from 'elkjs/lib/elk.bundled.js';

// Pure layout math the renderer builds on: the region-tiling split and the
// stadium-cap geometry. Nothing here touches the DOM or ELK, so it is
// deterministic and unit-tested directly (see test/geometry.test.ts). The
// renderer owns everything with side effects (measuring, layout, drawing).

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Whether sibling region boxes are laid out more vertically than horizontally,
// i.e. whether their fill should be split along the vertical axis. Measured
// from the spread of the box centres, so it reflects how ELK actually placed
// them (which need not match the declared direction once INCLUDE_CHILDREN is in
// play). Fewer than two boxes: the axis is irrelevant, reported as vertical.
export function regionsStackVertically(boxes: Rect[]): boolean {
  if (boxes.length < 2) return true;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const b of boxes) {
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    minX = Math.min(minX, cx);
    maxX = Math.max(maxX, cx);
    minY = Math.min(minY, cy);
    maxY = Math.max(maxY, cy);
  }
  return maxY - minY >= maxX - minX;
}

// Splits a container's fillable `interior` among its region children so they
// tile it edge to edge (each region "colors around its children"). Boxes are
// the regions' laid-out positions, in declaration order; the split runs along
// the layout axis (`vertical` for a top/bottom stack) with each internal
// boundary at the midpoint of the gap between neighbours, and the outer regions
// reaching the interior's edges. The cross axis always spans the full interior.
// Returned rects are in the same order as `boxes`.
export function partitionRegions(
  interior: Rect,
  boxes: Rect[],
  vertical: boolean,
): Rect[] {
  const n = boxes.length;
  if (n === 0) return [];
  const start = (b: Rect) => (vertical ? b.y : b.x);
  const end = (b: Rect) => (vertical ? b.y + b.h : b.x + b.w);
  const center = (b: Rect) => (start(b) + end(b)) / 2;

  // Order regions along the main axis; boundaries are computed in that order,
  // then mapped back so the result lines up with the input order.
  const order = boxes.map((_, i) => i).sort((a, b) => center(boxes[a]) - center(boxes[b]));
  const lo = vertical ? interior.y : interior.x;
  const hi = vertical ? interior.y + interior.h : interior.x + interior.w;

  const bounds = [lo];
  for (let k = 1; k < n; k++) {
    bounds.push((end(boxes[order[k - 1]]) + start(boxes[order[k]])) / 2);
  }
  bounds.push(hi);

  const result: Rect[] = new Array(n);
  for (let k = 0; k < n; k++) {
    const a = bounds[k];
    const b = bounds[k + 1];
    result[order[k]] = vertical
      ? { x: interior.x, y: a, w: interior.w, h: b - a }
      : { x: a, y: interior.y, w: b - a, h: interior.h };
  }
  return result;
}

// The padding a stadium cap must add so content of half-extent `hw` clears the
// curve: the cap narrows as sqrt(r² - d²), so a box reaching half-extent hw fits
// once it is `r - sqrt(r² - hw²)` in from the tip. That is the *minimal* inset —
// far less than the full radius when the content is narrower than the cap.
export function capInset(r: number, hw: number): number {
  const clamped = Math.min(hw, r);
  return r - Math.sqrt(Math.max(0, r * r - clamped * clamped));
}

// Node ids are dot-paths that mirror the entity tree (`n0`, `n0.1`, `n0.1.2`),
// so an edge's lowest common ancestor — the container ELK must hold it in — is
// just the longest shared dot-prefix of its two endpoint ids. An empty result
// means the root graph; a result equal to one endpoint means that endpoint is
// an ancestor of the other (the edge is contained by the ancestor itself).
export function commonAncestorId(a: string, b: string): string {
  const pa = a.split('.');
  const pb = b.split('.');
  const shared: string[] = [];
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    if (pa[i] !== pb[i]) break;
    shared.push(pa[i]);
  }
  return shared.join('.');
}

// The largest half-extent of any child measured from the container's mid-line,
// along the axis that faces the caps (horizontal for a vertical stadium).
export function childHalfExtent(node: ElkNode, vertical: boolean): number {
  const mid = (vertical ? node.width ?? 0 : node.height ?? 0) / 2;
  let hw = 0;
  for (const c of node.children ?? []) {
    const lo = (vertical ? c.x : c.y) ?? 0;
    const hi = lo + ((vertical ? c.width : c.height) ?? 0);
    hw = Math.max(hw, mid - lo, hi - mid);
  }
  return hw;
}
