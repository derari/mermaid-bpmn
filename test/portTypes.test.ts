import { describe, expect, it } from 'vitest';
import type { Entity, EntityType, Line, LineType } from '../src/db.js';
import { analysePorts } from '../src/portTypes.js';

const ent = (name: string, type: EntityType = 'activity', children: Entity[] = []): Entity => ({
  name,
  type,
  children,
});

const line = (source: string, target: string, type: LineType = '---'): Line => ({
  source,
  target,
  type,
});

describe('analysePorts', () => {
  it('flags an arrowhead that lands on a port', () => {
    const roots = [ent('A'), ent('Box', 'activity', [ent('In', 'port')])];
    const v = analysePorts(roots, []);
    // `-->` heads the target: invalid when the target is a port.
    expect(v.isInvalidLine(line('A', 'In', '-->'))).toBe(true);
    // `<--` heads the source: invalid when the source is a port.
    expect(v.isInvalidLine(line('In', 'A', '<--'))).toBe(true);
  });

  it('accepts an undirected line touching a port', () => {
    const roots = [ent('A'), ent('Box', 'activity', [ent('In', 'port')])];
    const v = analysePorts(roots, []);
    expect(v.isInvalidLine(line('A', 'In', '---'))).toBe(false);
  });

  it('accepts an arrow whose head lands away from the port', () => {
    const roots = [ent('A'), ent('Box', 'activity', [ent('In', 'port')])];
    const v = analysePorts(roots, []);
    // Head on A (a non-port), tail on the port — valid.
    expect(v.isInvalidLine(line('In', 'A', '-->'))).toBe(false);
  });

  it('never flags a line between two non-ports', () => {
    const roots = [ent('A'), ent('B')];
    const v = analysePorts(roots, []);
    expect(v.isInvalidLine(line('A', 'B', '-->'))).toBe(false);
  });

  it('ignores unresolved or self-referential lines', () => {
    const roots = [ent('A', 'activity', [ent('In', 'port')])];
    const v = analysePorts(roots, []);
    expect(v.isInvalidLine(line('A', 'Missing', '-->'))).toBe(false);
    expect(v.isInvalidLine(line('A', 'A', '-->'))).toBe(false);
  });
});
