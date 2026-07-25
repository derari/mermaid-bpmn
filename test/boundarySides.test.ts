import { beforeEach, describe, expect, it } from 'vitest';
import { type Entity, type Side, db } from '../src/db.js';
import { parser } from '../src/parser.js';
import { resolveBoundaryAutoSides } from '../src/boundarySides.js';

// Parses a DSL body (header prepended) and returns the smart auto-side pick keyed
// by the boundary event's id, so assertions read in the DSL's own vocabulary.
function sidesById(...lines: string[]): Record<string, Side> {
  parser.parse(['bpmn', ...lines].join('\n'));
  const map = resolveBoundaryAutoSides(db.getRoot(), db.getDirection(), db.getLines());
  const byName = new Map<Entity, string>();
  const index = (e: Entity): void => {
    if (e.name) byName.set(e, e.name);
    e.children.forEach(index);
  };
  db.getEntities().forEach(index);
  const out: Record<string, Side> = {};
  for (const [entity, side] of map) out[byName.get(entity) ?? '?'] = side;
  return out;
}

describe('resolveBoundaryAutoSides', () => {
  beforeEach(() => db.clear());

  it('faces a handler in the lane below (LR flow → south)', () => {
    const sides = sidesById(
      'pool P',
      '  lane Top',
      '    task A',
      '      error boundary b',
      '  lane Bottom',
      '    task Fix',
      'b --> Fix',
    );
    expect(sides).toEqual({ b: 's' });
  });

  it('faces a handler in the lane above (LR flow → north)', () => {
    const sides = sidesById(
      'pool P',
      '  lane Top',
      '    task Fix',
      '  lane Bottom',
      '    task A',
      '      error boundary b',
      'b --> Fix',
    );
    expect(sides).toEqual({ b: 'n' });
  });

  it('flips with a vertical pool (cross axis is now east/west)', () => {
    const sides = sidesById(
      'bpmn tb',
      '  pool P',
      '    lane L1',
      '      task A',
      '        error boundary b',
      '    lane L2',
      '      task Fix',
      '  b --> Fix',
    );
    // TB flow, pool stacks lanes left→right; L2 is to the east of L1.
    expect(sides).toEqual({ b: 'e' });
  });

  it('preserves the sign for a reversed pool (RL flow → BT lane stack)', () => {
    const sides = sidesById(
      'bpmn rl',
      '  pool P',
      '    lane L1',
      '      task A',
      '        error boundary b',
      '    lane L2',
      '      task Fix',
      '  b --> Fix',
    );
    // RL flow toggles to a BT lane stack (sign preserved): the later lane L2 sits
    // NORTH of L1, so the handler faces north (the old sign-losing map faced south).
    expect(sides).toEqual({ b: 'n' });
  });

  it('yields no smart side when the handler is along the flow axis (same lane)', () => {
    // A and Fix are siblings flowing LR; the handler is downstream, not across —
    // so there is no cross signal and the caller keeps the 90°-cw default.
    const sides = sidesById(
      'task A',
      '  error boundary b',
      'task Fix',
      'b --> Fix',
    );
    expect(sides).toEqual({});
  });

  it('yields no smart side when the event has no single clear partner', () => {
    const sides = sidesById(
      'pool P',
      '  lane Top',
      '    task A',
      '      error boundary b',
      '  lane Bottom',
      '    task Fix',
      '    task Other',
      'b --> Fix',
      'b --> Other',
    );
    expect(sides).toEqual({});
  });

  it('ignores an explicit side (only auto/omitted events get a smart pick)', () => {
    const sides = sidesById(
      'pool P',
      '  lane Top',
      '    task A',
      '      error boundary b n',
      '  lane Bottom',
      '    task Fix',
      'b --> Fix',
    );
    expect(sides).toEqual({});
  });
});
