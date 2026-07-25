import { describe, expect, it, vi } from 'vitest';
import { type ComplexLineSpec, expandComplexLines } from '../src/complexLines.js';
import { type Entity, type EntityType } from '../src/db.js';

const ent = (name: string, type: EntityType = 'activity', children: Entity[] = []): Entity => ({
  name,
  type,
  children,
});

const names = (children: Entity[]): string[] => children.map((c) => c.name);

describe('expandComplexLines', () => {
  it('emits one segment per arrow, wiring consecutive entities', () => {
    const a = ent('A');
    const b = ent('B');
    const c = ent('C');
    const roots = [a, b, c];

    const lines = expandComplexLines(roots, [
      { nodes: [{ entity: 'A' }, { entity: 'B' }, { entity: 'C' }], arrows: ['-->', '-->'] },
    ]);

    // The tree is never mutated — this dialect inserts no connectors.
    expect(names(roots)).toEqual(['A', 'B', 'C']);
    expect(lines).toEqual([
      { source: a, target: b, type: '-->' },
      { source: b, target: c, type: '-->' },
    ]);
  });

  it('preserves each arrow direction', () => {
    const a = ent('A');
    const b = ent('B');
    const c = ent('C');
    const lines = expandComplexLines([a, b, c], [
      { nodes: [{ entity: 'A' }, { entity: 'B' }, { entity: 'C' }], arrows: ['<--', '---'] },
    ]);
    expect(lines).toEqual([
      { source: a, target: b, type: '<--' },
      { source: b, target: c, type: '---' },
    ]);
  });

  it('accepts a direct entity reference (relative form)', () => {
    const a = ent('A');
    const b = ent('B');
    const c = ent('C');
    const lines = expandComplexLines([a, b, c], [
      { nodes: [{ entity: a }, { entity: 'B' }, { entity: 'C' }], arrows: ['-->', '-->'] },
    ]);
    expect(lines[0].source).toBe(a);
  });

  it('carries style, container, and routing onto every segment', () => {
    const a = ent('A');
    const b = ent('B');
    const c = ent('C');
    const container = ent('Lane', 'lane', [a, b, c]);
    const lines = expandComplexLines([container], [
      {
        nodes: [{ entity: 'A' }, { entity: 'B' }, { entity: 'C' }],
        arrows: ['-->', '-->'],
        style: { stroke: 'red' },
        container,
        routing: { bend: 'z' },
      },
    ]);
    for (const line of lines) {
      expect(line.style).toEqual({ stroke: 'red' });
      expect(line.container).toBe(container);
      expect(line.routing).toEqual({ bend: 'z' });
    }
  });

  it('resolves names across the whole tree (nested entities)', () => {
    const deep = ent('Deep');
    const lane = ent('Lane', 'lane', [deep]);
    const a = ent('A');
    const roots = [a, lane];
    const lines = expandComplexLines(roots, [
      { nodes: [{ entity: 'A' }, { entity: 'Deep' }], arrows: ['-->'] },
    ]);
    expect(lines).toEqual([{ source: a, target: deep, type: '-->' }]);
  });

  it('skips a chain whose endpoint does not resolve, without mutating the tree', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const a = ent('A');
    const roots = [a];

    const lines = expandComplexLines(roots, [
      { nodes: [{ entity: 'A' }, { entity: 'Missing' }, { entity: 'A' }], arrows: ['-->', '-->'] },
    ]);

    expect(lines).toEqual([]);
    expect(names(roots)).toEqual(['A']);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('returns nothing for an empty spec list', () => {
    expect(expandComplexLines([ent('A')], [])).toEqual([]);
  });
});
