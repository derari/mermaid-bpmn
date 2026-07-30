import { describe, expect, it } from 'vitest';
import { type DirNode, analyzeInterior, normalizeDirections } from '../src/layout/routePlan.js';
import type { Direction } from '../src/layout/model.js';

const line = (sourceOwner: string, targetOwner: string, lca: string) => ({
  sourceOwner,
  targetOwner,
  lca,
  sourceFixed: false,
  targetFixed: false,
});

// Build a DirNode tree from a compact spec. A node is `{id, children}`; leaves have
// no children. Directions are supplied separately as an explicit-direction map.
function node(id: string, children: DirNode[] = []): DirNode {
  return { id, children };
}
// Index a tree into an id -> node lookup (a `nodeOf` for analyzeInterior).
function indexTree(root: DirNode): (id: string) => DirNode | undefined {
  const byId = new Map<string, DirNode>();
  const walk = (n: DirNode): void => {
    byId.set(n.id, n);
    for (const c of n.children ?? []) walk(c);
  };
  walk(root);
  return (id) => byId.get(id);
}
const dirs = (entries: Record<string, Direction>) => ({
  get: (id: string): Direction | undefined => entries[id],
});

describe('normalizeDirections', () => {
  it('black-boxes a branching differing container; flattens single-child shells above it', () => {
    // root(lr) > W(tb, 1 child) > X(1 child) > Y(2 children). The tb pushes down the
    // W>X shell chain to Y's parent X — X branches (Y has 2 kids? no: X has 1 child Y;
    // Y has 2). So X is a shell (1 child) whose child Y branches → X is the boundary.
    const tree = node('', [node('W', [node('X', [node('Y', [node('Y.0'), node('Y.1')])])])]);
    const { dir, separate } = normalizeDirections(tree, dirs({ W: 'TB' }), 'LR');
    expect(dir.get('W')).toBe('LR'); // shell normalized away
    expect(separate.has('W')).toBe(false);
    expect(separate.has('X')).toBe(true); // the real boundary (tb, its child Y branches)
    expect(dir.get('X')).toBe('TB');
    expect(dir.get('Y')).toBe('TB'); // Y inherits X's tb, same → transparent
    expect(separate.has('Y')).toBe(false);
  });

  it('black-boxes a shell whose direct child branches (reference w>x>{channel,y})', () => {
    // root(lr) > b > {c(leaf), w(tb)} ; w > x > {channel(leaf), y} ; y > z(leaf).
    const tree = node('', [
      node('b', [
        node('c'),
        node('w', [node('x', [node('channel'), node('y', [node('z')])])]),
      ]),
    ]);
    const { dir, separate } = normalizeDirections(tree, dirs({ w: 'TB' }), 'LR');
    // w is a shell (1 box child x) but x branches (channel + y) → w cannot collapse → SEPARATE.
    expect(separate.has('w')).toBe(true);
    expect(dir.get('w')).toBe('TB');
    expect(dir.get('x')).toBe('TB'); // x inherits w, same → transparent, flattenable
    expect(dir.get('y')).toBe('TB');
    expect(separate.has('x')).toBe(false);
    expect(separate.has('y')).toBe(false);
    expect(dir.get('b')).toBe('LR');
  });

  it('collapses a single-leaf shell (no visible direction)', () => {
    const tree = node('', [node('W', [node('leaf')])]);
    const { dir, separate } = normalizeDirections(tree, dirs({ W: 'TB' }), 'LR');
    expect(dir.get('W')).toBe('LR');
    expect(separate.size).toBe(0);
  });

  it('black-boxes a two-leaf differing container (arrangement is visible)', () => {
    const tree = node('', [node('W', [node('a'), node('b')])]);
    const { separate, dir } = normalizeDirections(tree, dirs({ W: 'TB' }), 'LR');
    expect(separate.has('W')).toBe(true);
    expect(dir.get('W')).toBe('TB');
  });

  it('does not black-box a same-direction branching container', () => {
    const tree = node('', [node('W', [node('a'), node('b')])]);
    const { separate } = normalizeDirections(tree, dirs({ W: 'LR' }), 'LR');
    expect(separate.size).toBe(0);
  });

  it('wraps a black-box a line exits through a container-child (reference z--s)', () => {
    // w=n0.1.1 (black-box) > x(container) > y(container) > z; z--s exits w through x.
    const nodeOf = indexTree(
      node('', [node('n1'), node('n0.1.1', [node('n0.1.1.0', [node('n0.1.1.0.1', [node('n0.1.1.0.1.0')])])])]),
    );
    const sep = new Set(['n0.1.1']);
    expect([...analyzeInterior(sep, [line('n0.1.1.0.1.0', 'n1', '')], nodeOf)]).toEqual(['n0.1.1']);
  });

  it('wraps a black-box for an INTERNAL line crossing its container-children (a--b)', () => {
    // R=n0 (black-box, and the LCA) with container children P=n0.0, Q=n0.1; a--b crosses.
    const nodeOf = indexTree(
      node('', [node('n0', [node('n0.0', [node('n0.0.0')]), node('n0.1', [node('n0.1.0')])])]),
    );
    const sep = new Set(['n0']);
    expect([...analyzeInterior(sep, [line('n0.0.0', 'n0.1.0', 'n0')], nodeOf)]).toEqual(['n0']);
  });

  it('does NOT wrap a black-box when a line only touches a LEAF child', () => {
    // W=n0.1 (black-box) with a leaf child n0.1.0 — no container interior to flatten.
    const nodeOf = indexTree(node('', [node('n1'), node('n0.1', [node('n0.1.0')])]));
    const sep = new Set(['n0.1']);
    expect([...analyzeInterior(sep, [line('n0.1.0', 'n1', '')], nodeOf)]).toEqual([]);
  });

  it('pushes a differing direction all the way down a uniform single-child chain', () => {
    // root(lr) > W(tb) > X > Y > z(leaf): pure chain, no branching → all invisible.
    const tree = node('', [node('W', [node('X', [node('Y', [node('z')])])])]);
    const { dir, separate } = normalizeDirections(tree, dirs({ W: 'TB' }), 'LR');
    expect(separate.size).toBe(0);
    expect(dir.get('W')).toBe('LR');
    expect(dir.get('X')).toBe('LR');
    expect(dir.get('Y')).toBe('LR');
  });
});
