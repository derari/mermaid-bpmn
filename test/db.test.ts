import { beforeEach, describe, expect, it } from 'vitest';
import { type Entity, type EntityType, db, entityLabel } from '../src/db.js';

describe('entityLabel', () => {
  const make = (type: EntityType, name: string, label?: string): Entity => ({
    name,
    ...(label !== undefined ? { label } : {}),
    type,
    children: [],
  });

  it('defaults a name-as-label family to its id', () => {
    for (const type of ['pool', 'lane', 'activity', 'data', 'event'] as const) {
      expect(entityLabel(make(type, 'Approve'))).toBe('Approve');
    }
  });

  it('defaults gates and regions to no caption', () => {
    for (const type of ['gate', 'region'] as const) {
      expect(entityLabel(make(type, 'g1'))).toBe('');
    }
  });

  it('uses an explicit label over the id', () => {
    expect(entityLabel(make('activity', 'a', 'Approve order'))).toBe('Approve order');
    expect(entityLabel(make('event', 'start', 'Order received'))).toBe('Order received');
  });

  it('suppresses the caption for an explicit empty label', () => {
    expect(entityLabel(make('activity', 'a', ''))).toBe('');
  });

  it('never draws a caption for a port', () => {
    expect(entityLabel(make('port', 'In'))).toBe('');
    expect(entityLabel(make('port', 'In', 'ignored'))).toBe('');
  });
});

// The diagram is modelled as a single root container entity; the public getters
// are just views onto it, so "diagram scope" is never a special case.
describe('root entity', () => {
  beforeEach(() => db.clear());

  it('is an unnamed region, and getEntities() is a view of its children', () => {
    const root = db.getRoot();
    expect(root.type).toBe('region');
    expect(db.getEntities()).toBe(root.children);
    const a = db.addEntity('A', 'activity'); // no parent -> top level
    expect(root.children).toEqual([a]);
    expect(db.getEntities()).toEqual([a]);
  });

  it('backs the diagram direction with the root entity (default LR)', () => {
    expect(db.getDirection()).toBe('LR');
    db.setDirection('TB'); // no target -> the diagram default
    expect(db.getDirection()).toBe('TB');
    expect(db.getRoot().direction).toBe('TB');
    // A target still sets that entity's own direction, not the diagram default.
    const a = db.addEntity('A', 'lane');
    db.setDirection('RL', a);
    expect(a.direction).toBe('RL');
    expect(db.getDirection()).toBe('TB');
  });

  it('exposes the root entity own style as the diagram-wide default style', () => {
    expect(db.getRootStyle()).toEqual({});
    db.getRoot().style = { stroke: 'red' };
    expect(db.getRootStyle()).toEqual({ stroke: 'red' });
  });

  it('clear() installs a fresh root (state does not leak between parses)', () => {
    const first = db.getRoot();
    db.addEntity('A', 'activity');
    db.setDirection('LR');
    db.clear();
    expect(db.getRoot()).not.toBe(first);
    expect(db.getEntities()).toEqual([]);
    expect(db.getDirection()).toBe('LR');
    expect(db.getRootStyle()).toEqual({});
  });
});

describe('addEntity', () => {
  beforeEach(() => db.clear());

  it('creates a bare node of the given family under the given parent', () => {
    const lane = db.addEntity('L', 'lane');
    const act = db.addEntity('A', 'activity', lane);
    expect(act).toEqual({ name: 'A', type: 'activity', children: [] });
    expect(lane.children).toEqual([act]);
    expect(db.getEntities()).toEqual([lane]);
  });
});

describe('addLine', () => {
  beforeEach(() => db.clear());

  it('stores endpoints verbatim, omitting a null container', () => {
    const line = db.addLine('A', 'B', '-->');
    expect(line).toEqual({ source: 'A', target: 'B', type: '-->' });
    expect(db.getLines()).toEqual([line]);
  });

  it('records a relative line container', () => {
    const c = db.addEntity('C', 'lane');
    const line = db.addLine(c, 'B', '---', c);
    expect(line).toEqual({ source: c, target: 'B', type: '---', container: c });
  });
});

describe('styles and classes', () => {
  beforeEach(() => db.clear());

  it('merges repeated classDefs per property', () => {
    db.addClassDef('hot', { fill: 'red' });
    db.addClassDef('hot', { stroke: 'black' });
    expect(db.getClassDefs().get('hot')).toEqual({ fill: 'red', stroke: 'black' });
  });

  it('accumulates named styles and class assignments', () => {
    db.addNamedStyle('A', { fill: 'red' });
    db.addNamedStyle('A', { stroke: 'blue' });
    expect(db.getNamedStyles().get('A')).toEqual({ fill: 'red', stroke: 'blue' });

    db.addNamedClasses('A', ['x']);
    db.addNamedClasses('A', ['y']);
    expect(db.getNamedClasses().get('A')).toEqual(['x', 'y']);
  });
});

describe('debug ports flag', () => {
  beforeEach(() => db.clear());

  it('is off by default and toggles on', () => {
    expect(db.getDebugPorts()).toBe(false);
    db.setDebugPorts(true);
    expect(db.getDebugPorts()).toBe(true);
  });
});
