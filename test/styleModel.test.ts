import { describe, expect, it } from 'vitest';
import type { Entity, EntityType, StyleProps } from '../src/db.js';
import { type ThemeDefaults, resolveStyles } from '../src/styleModel.js';

const THEME: ThemeDefaults = { fill: '#ececff', stroke: '#9370db' };

const ent = (
  name: string,
  over: Partial<Entity> = {},
  children: Entity[] = [],
): Entity => ({
  name,
  type: 'activity',
  children,
  ...over,
});

const resolve = (
  roots: Entity[],
  opts: {
    classDefs?: Map<string, StyleProps>;
    namedStyles?: Map<string, StyleProps>;
    namedClasses?: Map<string, string[]>;
    theme?: ThemeDefaults;
    rootStyle?: StyleProps;
  } = {},
) =>
  resolveStyles(
    roots,
    opts.classDefs ?? new Map(),
    opts.namedStyles ?? new Map(),
    opts.namedClasses ?? new Map(),
    opts.theme ?? THEME,
    opts.rootStyle ?? {},
  );

describe('resolveStyles', () => {
  it('gives a lone entity the theme fill and border', () => {
    const a = ent('A');
    const r = resolve([a]).get(a);
    expect(r).toEqual({ fill: '#ececff', border: '#9370db', strokeExplicit: undefined });
  });

  it('applies a flat fill to just that node, not its children', () => {
    const child = ent('Child');
    const a = ent('A', { style: { fill: '#ffd54f' } }, [child]);
    const map = resolve([a]);
    expect(map.get(a)?.fill).toBe('#ffd54f');
    // Fill never cascades: the child keeps the theme fill.
    expect(map.get(child)?.fill).toBe('#ececff');
  });

  it('inherits an explicit stroke to descendants and reports it for lines', () => {
    const child = ent('Child');
    const a = ent('A', { style: { stroke: '#455a64' } }, [child]);
    const map = resolve([a]);
    expect(map.get(a)?.border).toBe('#455a64');
    expect(map.get(child)?.border).toBe('#455a64');
    expect(map.get(child)?.strokeExplicit).toBe('#455a64');
  });

  it('lets a nested stroke override an inherited one for its own subtree', () => {
    const leaf = ent('Leaf');
    const inner = ent('Inner', { style: { stroke: '#2e7d32' } }, [leaf]);
    const root = ent('Root', { style: { stroke: '#c62828' } }, [inner]);
    const map = resolve([root]);
    expect(map.get(leaf)?.strokeExplicit).toBe('#2e7d32');
  });

  it('merges classDef styles, with bare style winning over class and name', () => {
    const classDefs = new Map<string, StyleProps>([
      ['imp', { fill: '#111', stroke: '#222' }],
    ]);
    const namedStyles = new Map<string, StyleProps>([['A', { fill: '#333' }]]);
    // Bare style overrides name-style fill; class supplies stroke; name loses fill.
    const a = ent('A', { classes: ['imp'], style: { fill: '#999' } });
    const map = resolve([a], { classDefs, namedStyles });
    expect(map.get(a)?.fill).toBe('#999');
    expect(map.get(a)?.border).toBe('#222');
  });

  it('applies class assignments made by name via `class` statements', () => {
    const classDefs = new Map<string, StyleProps>([['hot', { fill: '#f00' }]]);
    const namedClasses = new Map<string, string[]>([['A', ['hot']]]);
    const a = ent('A');
    const map = resolve([a], { classDefs, namedClasses });
    expect(map.get(a)?.fill).toBe('#f00');
  });

  describe('icon', () => {
    it('resolves an entity own icon and does not cascade it to children', () => {
      const child = ent('Child');
      const a = ent('A', { style: { icon: 'lucide:server' } }, [child]);
      const map = resolve([a]);
      expect(map.get(a)?.icon).toBe('lucide:server');
      // Like fill, the icon is per-node — the child starts without one.
      expect(map.get(child)?.icon).toBeUndefined();
    });

    it('follows the same class < name < bare-style precedence as colors', () => {
      const classDefs = new Map<string, StyleProps>([['svc', { icon: 'lucide:box' }]]);
      const namedStyles = new Map<string, StyleProps>([['A', { icon: 'lucide:database' }]]);
      const a = ent('A', { classes: ['svc'], style: { icon: 'lucide:server' } });
      // Bare style wins over the name style, which wins over the class.
      expect(resolve([a], { classDefs, namedStyles }).get(a)?.icon).toBe('lucide:server');
    });

    describe('activity task-type default', () => {
      it('defaults an activity with a task type to its bpmn glyph', () => {
        const a = ent('A', { type: 'activity', activityType: 'task', taskType: 'user' });
        expect(resolve([a]).get(a)?.icon).toBe('bpmn:user');
      });

      it('uses the task type verbatim (even one without a bpmn glyph)', () => {
        const a = ent('A', { type: 'activity', activityType: 'task', taskType: 'receive-instance' });
        expect(resolve([a]).get(a)?.icon).toBe('bpmn:receive-instance');
      });

      it('lets an explicit icon win over the task-type default', () => {
        const a = ent('A', {
          type: 'activity',
          activityType: 'task',
          taskType: 'user',
          style: { icon: 'lucide:server' },
        });
        expect(resolve([a]).get(a)?.icon).toBe('lucide:server');
      });

      it('gives no default to an activity without a task type', () => {
        const a = ent('A', { type: 'activity', activityType: 'task' });
        expect(resolve([a]).get(a)?.icon).toBeUndefined();
      });

      it('does not apply the activity default to non-activities without a type', () => {
        const r = ent('R', { type: 'region' as EntityType });
        expect(resolve([r]).get(r)?.icon).toBeUndefined();
      });
    });

    describe('gateway type marker', () => {
      it('defaults a gate to its type marker (exclusive when unset)', () => {
        const g = ent('G', { type: 'gate' as EntityType });
        expect(resolve([g]).get(g)?.icon).toBe('bpmn:exclusive');
      });

      it('uses the declared gate type', () => {
        const g = ent('G', { type: 'gate' as EntityType, gateType: 'parallel' });
        expect(resolve([g]).get(g)?.icon).toBe('bpmn:parallel');
      });

      it('lets an explicit icon win over the type marker', () => {
        const g = ent('G', { type: 'gate' as EntityType, style: { icon: 'lucide:git-fork' } });
        expect(resolve([g]).get(g)?.icon).toBe('lucide:git-fork');
      });
    });

    describe('event type marker', () => {
      const ev = (over: Partial<Entity>): Entity => ent('E', { type: 'event' as EntityType, ...over });

      it('uses <type>-in for a catching operation', () => {
        const e = ev({ eventType: 'message', eventOperation: 'catch' });
        expect(resolve([e]).get(e)?.icon).toBe('bpmn:message-in');
      });

      it('uses <type>-out for a throwing or ending operation', () => {
        const t = ev({ eventType: 'message', eventOperation: 'throw' });
        expect(resolve([t]).get(t)?.icon).toBe('bpmn:message-out');
        const n = ev({ eventType: 'error', eventOperation: 'end' });
        expect(resolve([n]).get(n)?.icon).toBe('bpmn:error-out');
      });

      it('draws no marker for a blank event (no type)', () => {
        const e = ev({ eventOperation: 'start' });
        expect(resolve([e]).get(e)?.icon).toBeUndefined();
      });

      it('lets an explicit icon win over the type marker', () => {
        const e = ev({ eventType: 'timer', eventOperation: 'catch', style: { icon: 'lucide:clock' } });
        expect(resolve([e]).get(e)?.icon).toBe('lucide:clock');
      });
    });
  });

  describe('diagram-root style', () => {
    it('seeds a diagram-wide stroke that cascades from the top', () => {
      const leaf = ent('Leaf');
      const root = ent('Root', {}, [leaf]);
      const map = resolve([root], { rootStyle: { stroke: '#123' } });
      expect(map.get(root)?.strokeExplicit).toBe('#123');
      expect(map.get(leaf)?.strokeExplicit).toBe('#123');
    });

    it('is overridden by a nearer own stroke', () => {
      const leaf = ent('Leaf');
      const mid = ent('Mid', { style: { stroke: '#2e7d32' } }, [leaf]);
      const map = resolve([mid], { rootStyle: { stroke: '#123' } });
      expect(map.get(leaf)?.strokeExplicit).toBe('#2e7d32');
    });

    it('does not seed fill (fill never cascades)', () => {
      const a = ent('A');
      const map = resolve([a], { rootStyle: { fill: 'red' } });
      // Root fill is inert; the node still shows the theme fill.
      expect(map.get(a)?.fill).toBe('#ececff');
    });
  });

  describe('region', () => {
    const region = (over: Partial<Entity> = {}, children: Entity[] = []): Entity =>
      ent('', { type: 'region' as EntityType, ...over }, children);

    it('is transparent by default', () => {
      const r = region({}, [ent('Inner')]);
      expect(resolve([r]).get(r)?.fill).toBe('transparent');
    });

    it('paints a flat fill when one is set', () => {
      const r = region({ style: { fill: '#eef' } }, [ent('A', {}, [ent('B')])]);
      expect(resolve([r]).get(r)?.fill).toBe('#eef');
    });

    it('threads an inherited stroke straight through to its children', () => {
      const leaf = ent('Leaf');
      const r = region({}, [leaf]);
      const root = ent('Root', { style: { stroke: '#c62828' } }, [r]);
      expect(resolve([root]).get(leaf)?.strokeExplicit).toBe('#c62828');
    });
  });
});
