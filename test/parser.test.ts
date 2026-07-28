import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type Entity, db, entityLabel } from '../src/db.js';
import { parser } from '../src/parser.js';

// Most tests declare entities directly under the `bpmn` header; this helper
// prepends it and joins lines so a test reads as the DSL body.
const parse = (...lines: string[]): void => parser.parse(['bpmn', ...lines].join('\n'));

// Collects every `error` node's label from the whole tree, so a test can assert a
// parse error surfaced as a diagnostic node (parsing never throws on bad syntax).
const errorLabels = (nodes: Entity[] = db.getEntities()): string[] =>
  nodes.flatMap((n) => [
    ...(n.type === 'error' ? [n.label ?? ''] : []),
    ...errorLabels(n.children),
  ]);

describe('bpmn parser', () => {
  beforeEach(() => db.clear());

  describe('header / direction', () => {
    it('sets the diagram direction from the header (bpmn LR works)', () => {
      parser.parse('bpmn LR');
      expect(db.getDirection()).toBe('LR');
    });

    it('accepts direction aliases', () => {
      parser.parse('bpmn TD');
      expect(db.getDirection()).toBe('TB');
    });

    it('defaults to LR with a bare header', () => {
      parser.parse('bpmn');
      expect(db.getDirection()).toBe('LR');
    });

    it('sets a nested container direction, not the diagram default', () => {
      parse('pool P', '  direction TB');
      const [pool] = db.getEntities();
      expect(pool.direction).toBe('TB');
      expect(db.getDirection()).toBe('LR');
    });

    it('ignores blank lines and comments', () => {
      parse('', '  %% a comment', '# also a comment', 'gate g');
      expect(db.getEntities()).toEqual([{ name: 'g', type: 'gate', children: [] }]);
    });

    it('clears previous state on re-parse', () => {
      parse('gate a');
      parse('gate b');
      expect(db.getEntities()).toEqual([{ name: 'b', type: 'gate', children: [] }]);
    });
  });

  describe('pool', () => {
    it('parses a pool at the root', () => {
      parse('pool "Sales" LR');
      expect(db.getEntities()).toEqual([
        { name: '', type: 'pool', children: [], label: 'Sales', direction: 'LR' },
      ]);
    });

    it('flags a pool that is not at the root as an error node', () => {
      parse('pool P', '  pool Q');
      expect(errorLabels().some((l) => /cannot contain a pool/.test(l))).toBe(true);
    });

    it('flags a non-lane child of a pool as an error node', () => {
      parse('pool P', '  task T');
      expect(errorLabels().some((l) => /cannot contain a activity/.test(l))).toBe(true);
      parse('pool P', '  region R');
      expect(errorLabels().some((l) => /cannot contain a region/.test(l))).toBe(true);
    });
  });

  describe('lane', () => {
    it('wraps a root-level lane in an inserted unnamed pool', () => {
      parse('lane L');
      expect(db.getEntities()).toEqual([
        { name: '', type: 'pool', children: [{ name: 'L', type: 'lane', children: [] }] },
      ]);
    });

    it('shares one auto-pool across several root-level lanes', () => {
      parse('lane A', 'lane B');
      const [pool] = db.getEntities();
      expect(pool.type).toBe('pool');
      expect(pool.children.map((c) => c.name)).toEqual(['A', 'B']);
    });

    it('nests a lane directly in an explicit pool (no wrapping)', () => {
      parse('pool P', '  lane L');
      expect(db.getEntities()).toEqual([
        { name: 'P', type: 'pool', children: [{ name: 'L', type: 'lane', children: [] }] },
      ]);
    });

    it('flags a lane nested in another lane as an error node', () => {
      parse('pool P', '  lane L', '    lane L2');
      expect(errorLabels().some((l) => /cannot contain a lane/.test(l))).toBe(true);
    });
  });

  describe('activity', () => {
    const activity = (over: Partial<Entity> = {}): Entity => ({
      name: 'T',
      type: 'activity',
      children: [],
      activityType: 'task',
      ...over,
    });

    it('parses each activity type, with process as an alias for subprocess', () => {
      parse(
        'task T1',
        'subprocess T2',
        'process T3',
        'call T4',
        'event-subprocess T5',
        'transaction T6',
      );
      expect(db.getEntities().map((e) => e.activityType)).toEqual([
        'task',
        'subprocess',
        'subprocess',
        'call',
        'event-subprocess',
        'transaction',
      ]);
    });

    it('peels a trailing direction on every container activity, keeping the id', () => {
      parse('subprocess S LR', 'event-subprocess E TB', 'transaction X RL');
      expect(db.getEntities()).toEqual([
        activity({ name: 'S', activityType: 'subprocess', direction: 'LR' }),
        activity({ name: 'E', activityType: 'event-subprocess', direction: 'TB' }),
        activity({ name: 'X', activityType: 'transaction', direction: 'RL' }),
      ]);
    });

    it('does not treat a trailing direction as inline on atomic activities', () => {
      parse('task T LR', 'call C RL');
      expect(db.getEntities()).toEqual([
        activity({ name: 'T LR' }),
        activity({ name: 'C RL', activityType: 'call' }),
      ]);
    });

    it('accepts the space and no-symbol spellings of hyphenated keywords', () => {
      parse(
        'sub process A',
        'sub-process B',
        'subprocess C',
        'event subprocess D',
        'eventsubprocess E',
        'ad hoc task F',
        'adhoc task G',
        'receive instance task H',
        'receiveinstance task I',
      );
      expect(db.getEntities()).toEqual([
        activity({ name: 'A', activityType: 'subprocess' }),
        activity({ name: 'B', activityType: 'subprocess' }),
        activity({ name: 'C', activityType: 'subprocess' }),
        activity({ name: 'D', activityType: 'event-subprocess' }),
        activity({ name: 'E', activityType: 'event-subprocess' }),
        activity({ name: 'F', marker: 'adhoc' }),
        activity({ name: 'G', marker: 'adhoc' }),
        activity({ name: 'H', taskType: 'receive-instance' }),
        activity({ name: 'I', taskType: 'receive-instance' }),
      ]);
    });

    it('parses a task type prefix', () => {
      parse('user task T');
      expect(db.getEntities()[0]).toEqual(activity({ taskType: 'user' }));
    });

    it('parses a marker, with multi as an alias for sequential', () => {
      parse('loop task A', 'multi task B', 'parallel task C');
      expect(db.getEntities().map((e) => e.marker)).toEqual(['loop', 'sequential', 'parallel']);
    });

    it('parses the adhoc marker, accepting the ad-hoc spelling', () => {
      parse('adhoc task A', 'ad-hoc task B');
      expect(db.getEntities().map((e) => e.marker)).toEqual(['adhoc', 'adhoc']);
    });

    it('omits the default instance marker', () => {
      parse('instance task T');
      expect(db.getEntities()[0]).toEqual(activity());
    });

    it('parses marker + task-type + activity-type together', () => {
      parse('parallel service task T "Charge"');
      expect(db.getEntities()[0]).toEqual(
        activity({ label: 'Charge', taskType: 'service', marker: 'parallel' }),
      );
    });

    it('lets a subprocess hold the full set of lane children', () => {
      parse('subprocess S', '  task T', '  start s', '  exclusive gate g');
      const [sp] = db.getEntities();
      expect(sp.children.map((c) => c.type)).toEqual(['activity', 'event', 'gate']);
    });

    it('lets a task hold a boundary event', () => {
      parse('task T', '  message boundary b');
      const [t] = db.getEntities();
      expect(t.children).toEqual([
        { name: 'b', type: 'event', children: [], eventType: 'message', eventOperation: 'boundary' },
      ]);
    });

    it('flags a non-boundary event inside a task as an error node', () => {
      parse('task T', '  start s');
      expect(errorLabels().some((l) => /can only contain boundary events/.test(l))).toBe(true);
    });
  });

  describe('boundary event direction', () => {
    it('peels a trailing compass side into boundarySide, keeping the id', () => {
      parse('task T', '  message boundary b s');
      expect(db.getEntities()[0].children[0]).toEqual({
        name: 'b',
        type: 'event',
        children: [],
        eventType: 'message',
        eventOperation: 'boundary',
        boundarySide: 's',
      });
    });

    it('accepts a compass word, and auto/? for an inferred side', () => {
      parse('task T', '  timer boundary a west', '  error boundary b auto', '  signal boundary c ?');
      expect(db.getEntities()[0].children.map((e) => [e.name, e.boundarySide])).toEqual([
        ['a', 'w'],
        ['b', 'auto'],
        ['c', 'auto'],
      ]);
    });

    it('leaves boundarySide unset when no direction is given', () => {
      parse('task T', '  timer boundary b');
      expect(db.getEntities()[0].children[0].boundarySide).toBeUndefined();
    });

    it('only peels a side for boundary ops, not other event operations', () => {
      // A catch event keeps `e` as its id — the trailing-side rule is boundary-only.
      parse('catch e');
      expect(db.getEntities()[0]).toEqual({
        name: 'e',
        type: 'event',
        children: [],
        eventOperation: 'catch',
      });
    });
  });

  describe('gate', () => {
    it('defaults to an exclusive gate (type omitted)', () => {
      parse('gate g', 'exclusive gate h');
      expect(db.getEntities()).toEqual([
        { name: 'g', type: 'gate', children: [] },
        { name: 'h', type: 'gate', children: [] },
      ]);
    });

    it('parses the gate types', () => {
      parse('inclusive gate a', 'parallel gate b', 'event gate c');
      expect(db.getEntities().map((e) => e.gateType)).toEqual(['inclusive', 'parallel', 'event']);
    });
  });

  describe('data', () => {
    it('defaults to a data object (type omitted)', () => {
      parse('data d', 'data object e');
      expect(db.getEntities()).toEqual([
        { name: 'd', type: 'data', children: [] },
        { name: 'e', type: 'data', children: [] },
      ]);
    });

    it('parses a data store', () => {
      parse('data store Orders');
      expect(db.getEntities()[0]).toEqual({
        name: 'Orders',
        type: 'data',
        children: [],
        dataType: 'store',
      });
    });

    it('parses a data collection', () => {
      parse('data collection Items');
      expect(db.getEntities()[0]).toEqual({
        name: 'Items',
        type: 'data',
        children: [],
        dataType: 'collection',
      });
    });
  });

  describe('event', () => {
    const ev = (name: string, op: string, over: Partial<Entity> = {}): Entity => ({
      name,
      type: 'event',
      children: [],
      eventOperation: op as Entity['eventOperation'],
      ...over,
    });

    it('defaults start/end ids to the operation name, with an empty label', () => {
      parse('start', 'end');
      expect(db.getEntities()).toEqual([
        ev('start', 'start', { label: '' }),
        ev('end', 'end', { label: '' }),
      ]);
    });

    it('takes an explicit id after the operation', () => {
      parse('start s1', 'catch c1', 'throw t1');
      expect(db.getEntities()).toEqual([
        ev('s1', 'start'),
        ev('c1', 'catch'),
        ev('t1', 'throw'),
      ]);
    });

    it('parses an event type before the operation', () => {
      parse('message start', 'timer catch t1');
      expect(db.getEntities()).toEqual([
        ev('start', 'start', { eventType: 'message', label: '' }),
        ev('t1', 'catch', { eventType: 'timer' }),
      ]);
    });

    it('omits the default blank event type', () => {
      parse('blank start');
      expect(db.getEntities()).toEqual([ev('start', 'start', { label: '' })]);
    });

    it('parses the continue alias and boundary non-interrupt forms', () => {
      parse('continue n1', 'boundary b1', 'boundary non-interrupt b2', 'boundary continue b3');
      expect(db.getEntities().map((e) => e.eventOperation)).toEqual([
        'non-interrupt',
        'boundary',
        'boundary-non-interrupt',
        'boundary-non-interrupt',
      ]);
    });

    it('accepts the space and no-symbol spellings of non-interrupt', () => {
      parse(
        'non interrupt n1',
        'noninterrupt n2',
        'boundary non interrupt b1',
        'boundary noninterrupt b2',
      );
      expect(db.getEntities().map((e) => e.eventOperation)).toEqual([
        'non-interrupt',
        'non-interrupt',
        'boundary-non-interrupt',
        'boundary-non-interrupt',
      ]);
    });

    it('treats termination/error/cancel/escalation as end events of that type', () => {
      parse('termination', 'error', 'cancel', 'escalation');
      expect(db.getEntities()).toEqual([
        ev('termination', 'end', { eventType: 'termination', label: '' }),
        ev('error', 'end', { eventType: 'error', label: '' }),
        ev('cancel', 'end', { eventType: 'cancel', label: '' }),
        ev('escalation', 'end', { eventType: 'escalation', label: '' }),
      ]);
    });

    it('takes an explicit id for an additional operation', () => {
      parse('error e1');
      expect(db.getEntities()[0]).toEqual(ev('e1', 'end', { eventType: 'error' }));
    });

    it('reads the word as an event type when a real operation follows', () => {
      parse('error throw x', 'escalation start y');
      expect(db.getEntities()).toEqual([
        ev('x', 'throw', { eventType: 'error' }),
        ev('y', 'start', { eventType: 'escalation' }),
      ]);
    });
  });

  describe('labels', () => {
    it('turns a \\n escape in a quoted label into a newline, gobbling whitespace', () => {
      parse('task a "Line one  \\n  Line two"');
      expect(db.getEntities()[0].label).toBe('Line one\nLine two');
    });

    it('keeps an escaped backslash before n as a literal \\n, not a newline', () => {
      parse('task a "path\\\\name"');
      expect(db.getEntities()[0].label).toBe('path\\name');
      parse('task b "lit\\\\nfoo"');
      expect(db.getEntities()[0].label).toBe('lit\\nfoo');
    });

    it('still unescapes quotes and backslashes in a quoted label', () => {
      parse('task a "say \\"hi\\""');
      expect(db.getEntities()[0].label).toBe('say "hi"');
    });

    it('collects a multi-line label after a | marker, first line fixing the indent', () => {
      parse(
        'subprocess Bob |',
        '    Multi line label',
        '    First line defines indent',
        '      This line has two spaces',
        '    More...',
        '  task Nested in Bob',
      );
      const [bob] = db.getEntities();
      expect(bob.label).toBe(
        'Multi line label\nFirst line defines indent\n  This line has two spaces\nMore...',
      );
      // The shallower `task` line ends the label and nests as a child of Bob.
      expect(bob.children).toEqual([
        { name: 'Nested in Bob', type: 'activity', children: [], activityType: 'task' },
      ]);
    });

    it('keeps the reference name, class, and direction alongside a | marker', () => {
      parse(
        'classDef bob-style fill:red',
        'subprocess Bob | :::bob-style',
        '    Label text',
        'task After',
      );
      const [bob, after] = db.getEntities();
      expect(bob.name).toBe('Bob');
      expect(bob.label).toBe('Label text');
      expect(bob.classes).toEqual(['bob-style']);
      // Bob's label ended, so `task After` is a sibling, not a child.
      expect(after.name).toBe('After');
    });

    it('applies the \\n escape inside a multi-line label too', () => {
      parse('region R |', '    a \\n b');
      expect(db.getEntities()[0].label).toBe('a\nb');
    });

    it('treats a | with no deeper lines as an explicit empty label', () => {
      parse('task Bob |', 'task Sibling');
      const [bob, sibling] = db.getEntities();
      expect(bob.label).toBe('');
      expect(sibling.name).toBe('Sibling');
    });

    it('flags a | multi-line-label marker on a port as an error node', () => {
      parse('lane L', '  port p e |', '    label');
      expect(errorLabels().some((l) => /cannot have a label/.test(l))).toBe(true);
    });
  });

  describe('text (comment)', () => {
    it('parses a comment as a text entity, name and label like other families', () => {
      parse('comment note "See the spec"');
      expect(db.getEntities()).toEqual([
        { name: 'note', type: 'text', children: [], label: 'See the spec' },
      ]);
    });

    it('peels a trailing compass side into bracketSide, keeping the id', () => {
      parse('comment a e', 'comment b south');
      expect(db.getEntities().map((e) => [e.name, e.bracketSide])).toEqual([
        ['a', 'e'],
        ['b', 's'],
      ]);
    });

    it('treats auto/? (and an omitted side) as the default: no bracketSide stored', () => {
      parse('comment a auto', 'comment b ?', 'comment c');
      expect(db.getEntities().map((e) => e.bracketSide)).toEqual([undefined, undefined, undefined]);
      expect(db.getEntities().map((e) => e.name)).toEqual(['a', 'b', 'c']);
    });

    it('lets a text annotation hold ports', () => {
      parse('comment note w', '  port p e');
      const [text] = db.getEntities();
      expect(text.type).toBe('text');
      expect(text.bracketSide).toBe('w');
      expect(text.children).toEqual([{ name: 'p', type: 'port', children: [], portSide: 'e' }]);
    });

    it('flags a non-port child of a text annotation as an error node', () => {
      parse('comment note', '  task T');
      expect(errorLabels().some((l) => /cannot contain a activity/.test(l))).toBe(true);
    });

    it('carries an inline class and a multi-line | label', () => {
      parse('comment note e | :::hot', '    line one', '    line two');
      const [text] = db.getEntities();
      expect(text.classes).toEqual(['hot']);
      expect(text.bracketSide).toBe('e');
      expect(text.label).toBe('line one\nline two');
    });
  });

  describe('region and port (kept)', () => {
    it('parses a region with an optional label and trailing direction', () => {
      parse('region My Group LR');
      expect(db.getEntities()).toEqual([
        { name: 'My Group', type: 'region', children: [], direction: 'LR' },
      ]);
    });

    it('parses a port pinned to an edge of its container', () => {
      parse('lane L', '  port p1 e', '  port n');
      const [pool] = db.getEntities();
      const [lane] = pool.children;
      expect(lane.children).toEqual([
        { name: 'p1', type: 'port', children: [], portSide: 'e' },
        { name: '', type: 'port', children: [], portSide: 'n' },
      ]);
    });

    it('flags a port at the diagram root as an error node', () => {
      parse('port n');
      expect(errorLabels().some((l) => /cannot contain a port/.test(l))).toBe(true);
    });

    it('flags a port without a trailing direction as an error node', () => {
      parse('lane L', '  port foo');
      expect(errorLabels().some((l) => /needs a trailing direction/.test(l))).toBe(true);
    });

    it('flags a labelled port as an error node', () => {
      parse('lane L', '  port p "x" e');
      expect(errorLabels().some((l) => /cannot have a label/.test(l))).toBe(true);
    });
  });

  describe('group', () => {
    it('parses id, label, and trailing direction like a region', () => {
      parse('group My Group "Wrap" LR');
      expect(db.getEntities()).toEqual([
        { name: 'My Group', type: 'group', label: 'Wrap', children: [], direction: 'LR' },
      ]);
    });

    it('parses an inline class', () => {
      parse('group G:::hot');
      expect(db.getEntities()[0].classes).toEqual(['hot']);
    });

    it('defaults its caption to its name', () => {
      parse('group G');
      expect(entityLabel(db.getEntities()[0])).toBe('G');
    });

    it('holds flow children and nests at the root or in a lane', () => {
      parse('lane L', '  group G', '    task A', '    task B');
      const lane = db.getEntities()[0].children[0];
      const [g] = lane.children;
      expect(g.type).toBe('group');
      expect(g.children.map((c) => c.type)).toEqual(['activity', 'activity']);
    });
  });

  describe('lines (kept)', () => {
    it('parses an absolute line between two named entities', () => {
      parse('task A', 'task B', 'A --> B');
      expect(db.getLines()).toEqual([{ source: 'A', target: 'B', type: '-->' }]);
    });

    it('borrows the enclosing entity for a relative line', () => {
      parse('subprocess S', '  --> Done', '  task Done');
      const [sp] = db.getEntities();
      expect(db.getLines()).toEqual([
        { source: sp, target: 'Done', type: '-->', container: sp },
      ]);
    });

    it('expands a complex chain into one segment per arrow, by id only', () => {
      parse('task A', 'task B', 'task C', 'A --> B --> C');
      const [a, b, c] = db.getEntities();
      expect(db.getLines()).toEqual([
        { source: a, target: b, type: '-->' },
        { source: b, target: c, type: '-->' },
      ]);
    });

    describe('slash line ends', () => {
      it('reads a leading slash as a source-end slash on an undirected line', () => {
        parse('task A', 'task B', 'A /-- B');
        expect(db.getLines()).toEqual([{ source: 'A', target: 'B', type: '---', slash: 'start' }]);
      });

      it('reads a trailing slash as a target-end slash on an undirected line', () => {
        parse('task A', 'task B', 'A --/ B');
        expect(db.getLines()).toEqual([{ source: 'A', target: 'B', type: '---', slash: 'end' }]);
      });

      it('keeps the arrow direction alongside a leading slash (/-->)', () => {
        parse('task A', 'task B', 'A /--> B');
        expect(db.getLines()).toEqual([{ source: 'A', target: 'B', type: '-->', slash: 'start' }]);
      });

      it('keeps the arrow direction alongside a trailing slash (<--/)', () => {
        parse('task A', 'task B', 'A <--/ B');
        expect(db.getLines()).toEqual([{ source: 'A', target: 'B', type: '<--', slash: 'end' }]);
      });

      it('reads a slash on both ends (/--/)', () => {
        parse('task A', 'task B', 'A /--/ B');
        expect(db.getLines()).toEqual([{ source: 'A', target: 'B', type: '---', slash: 'both' }]);
      });

      it('carries a slash on a relative line, at the enclosing (target) end', () => {
        parse('subprocess S', '  --/ Done', '  task Done');
        const [sp] = db.getEntities();
        expect(db.getLines()).toEqual([
          { source: sp, target: 'Done', type: '---', slash: 'end', container: sp },
        ]);
      });

      it('carries a leading slash on a relative line, at the enclosing (source) end', () => {
        parse('subprocess S', '  /--> Done', '  task Done');
        const [sp] = db.getEntities();
        expect(db.getLines()).toEqual([
          { source: sp, target: 'Done', type: '-->', slash: 'start', container: sp },
        ]);
      });

      it('carries each arrow\'s own slash through a complex chain', () => {
        parse('task A', 'task B', 'task C', 'A /--> B --/ C');
        const [a, b, c] = db.getEntities();
        expect(db.getLines()).toEqual([
          { source: a, target: b, type: '-->', slash: 'start' },
          { source: b, target: c, type: '---', slash: 'end' },
        ]);
      });

      it('leaves a slash-free line without the field', () => {
        parse('task A', 'task B', 'A --> B');
        expect(db.getLines()).toEqual([{ source: 'A', target: 'B', type: '-->' }]);
      });

      it('accepts | as an alternate spelling of the slash mark', () => {
        parse('task A', 'task B', 'A |--> B');
        expect(db.getLines()).toEqual([{ source: 'A', target: 'B', type: '-->', slash: 'start' }]);
      });

      it('accepts a backslash as an alternate spelling of the slash mark', () => {
        parse('task A', 'task B', 'A <--\\ B');
        expect(db.getLines()).toEqual([{ source: 'A', target: 'B', type: '<--', slash: 'end' }]);
      });

      it('accepts the marks on both ends and mixed across a chain', () => {
        parse('task A', 'task B', 'task C', 'A |--| B --\\ C');
        const [a, b, c] = db.getEntities();
        expect(db.getLines()).toEqual([
          { source: a, target: b, type: '---', slash: 'both' },
          { source: b, target: c, type: '---', slash: 'end' },
        ]);
      });

      it('does not treat a bare | (multi-line label marker) as a connector', () => {
        parse('subprocess Bob |', '    Heading', '  task Inner');
        // The `|` opens a multi-line label on Bob, so no line is created.
        expect(db.getLines()).toEqual([]);
        expect(db.getEntities()[0].label).toBe('Heading');
      });
    });

    describe('line labels', () => {
      it('attaches a quoted label at the end of an absolute line', () => {
        parse('task A', 'task B', 'A --> B "go"');
        expect(db.getLines()).toEqual([{ source: 'A', target: 'B', type: '-->', label: 'go' }]);
      });

      it('labels a relative line', () => {
        parse('subprocess S', '  --> Done "next"', '  task Done');
        const [sp] = db.getEntities();
        expect(db.getLines()).toEqual([
          { source: sp, target: 'Done', type: '-->', label: 'next', container: sp },
        ]);
      });

      it('combines with a line-end slash', () => {
        parse('task A', 'task B', 'A /--> B "default"');
        expect(db.getLines()).toEqual([
          { source: 'A', target: 'B', type: '-->', slash: 'start', label: 'default' },
        ]);
      });

      it('applies a chain label to the first segment only', () => {
        parse('task A', 'task B', 'task C', 'A --> B --> C "first"');
        const [a, b, c] = db.getEntities();
        expect(db.getLines()).toEqual([
          { source: a, target: b, type: '-->', label: 'first' },
          { source: b, target: c, type: '-->' },
        ]);
      });

      it('honours \\n and quote escapes in a line label', () => {
        parse('task A', 'task B', 'A --> B "two\\nlines"');
        expect(db.getLines()[0].label).toBe('two\nlines');
      });

      it('does not treat an entity label as a line', () => {
        parse('task A "Approve"');
        expect(db.getLines()).toEqual([]);
        expect(entityLabel(db.getEntities()[0])).toBe('Approve');
      });

      it('leaves an unlabelled line without the field', () => {
        parse('task A', 'task B', 'A --> B');
        expect(db.getLines()[0].label).toBeUndefined();
      });
    });
  });

  describe('error nodes', () => {
    it('turns an unparseable line into an error node captioned with its number and text', () => {
      parse('task A', 'this is not valid bpmn');
      const entities = db.getEntities();
      const err = entities[entities.length - 1];
      expect(err.type).toBe('error');
      // `parse` prepends the `bpmn` header, so the bad line is source line 3.
      expect(err.label).toBe('line 3: invalid syntax\nthis is not valid bpmn');
    });

    it('inserts the error node where the bad line was written (inside its container)', () => {
      parse('subprocess S', '  gibberish here');
      const [sp] = db.getEntities();
      expect(sp.children.map((c) => c.type)).toEqual(['error']);
      expect(sp.children[0].label).toBe('line 3: invalid syntax\ngibberish here');
    });

    it('makes an unresolved line target an error node beside the valid end', () => {
      parse('task A', 'A --> Missing');
      const entities = db.getEntities();
      const err = entities[entities.length - 1];
      expect(err.type).toBe('error');
      expect(err.label).toBe('line 3: invalid target "Missing"');
      // The line is rewired to the error node so the broken link is drawn.
      expect(db.getLines()).toEqual([{ source: 'A', target: err, type: '-->' }]);
    });

    it('places the error node as a sibling of the resolved (source) end', () => {
      parse('lane L', '  task A', '  A --> Missing');
      const lane = db.getEntities()[0].children[0];
      const err = lane.children[lane.children.length - 1];
      expect(err.type).toBe('error');
      expect(err.label).toBe('line 4: invalid target "Missing"');
    });

    it('reports an unresolved source end too', () => {
      parse('task B', 'Missing --> B');
      const entities = db.getEntities();
      const err = entities[entities.length - 1];
      expect(err.type).toBe('error');
      expect(err.label).toBe('line 3: invalid target "Missing"');
      expect(db.getLines()).toEqual([{ source: err, target: 'B', type: '-->' }]);
    });

    it('inserts both error nodes at the root when neither end resolves', () => {
      parse('X --> Y');
      const errs = db.getEntities().filter((e) => e.type === 'error');
      expect(errs.map((e) => e.label)).toEqual([
        'line 2: invalid target "X"',
        'line 2: invalid target "Y"',
      ]);
      const [line] = db.getLines();
      expect(line.source).toBe(errs[0]);
      expect(line.target).toBe(errs[1]);
    });

    it('leaves a fully resolved line untouched (string endpoints kept)', () => {
      parse('task A', 'task B', 'A --> B');
      expect(db.getEntities().some((e) => e.type === 'error')).toBe(false);
      expect(db.getLines()).toEqual([{ source: 'A', target: 'B', type: '-->' }]);
    });
  });

  describe('auto-sequence', () => {
    it('does nothing by default (root default off)', () => {
      parse('task A', 'task B');
      expect(db.getLines()).toEqual([]);
    });

    it('sets the flag on the enclosing container (bare = on)', () => {
      parse('pool P', '  lane L', '    auto-sequence');
      const lane = db.getEntities()[0].children[0];
      expect(lane.autoSequence).toBe(true);
    });

    it('parses on/off explicitly', () => {
      parse('auto-sequence off');
      expect(db.getRoot().autoSequence).toBe(false);
    });

    it('accepts the space and no-symbol spellings of the directive', () => {
      parse('auto sequence off');
      expect(db.getRoot().autoSequence).toBe(false);
      parse('autosequence on');
      expect(db.getRoot().autoSequence).toBe(true);
    });

    it('chains unlinked flow children in declaration order', () => {
      parse('auto-sequence on', 'task A', 'task B', 'task C');
      const [a, b, c] = db.getEntities();
      expect(db.getLines()).toEqual([
        { source: a, target: b, type: '-->' },
        { source: b, target: c, type: '-->' },
      ]);
    });

    it('skips a child that already has an outgoing line', () => {
      parse('auto-sequence on', 'task A', 'task B', 'task C', 'A --> C');
      const [a, b, c] = db.getEntities();
      expect(db.getLines()).toEqual([
        { source: 'A', target: 'C', type: '-->' },
        { source: b, target: c, type: '-->' },
      ]);
    });

    it('treats the tail of a <-- line as already outgoing', () => {
      parse('auto-sequence on', 'task A', 'task B', 'B <-- A');
      const [a] = db.getEntities();
      // A --> B is implied by `B <-- A`, so A is not re-sequenced.
      expect(db.getLines()).toEqual([{ source: 'B', target: 'A', type: '<--' }]);
      expect(a.name).toBe('A');
    });

    it('connects to the next flow element, skipping non-flow siblings', () => {
      parse('auto-sequence on', 'task A', 'data D', 'task B');
      const [a, , b] = db.getEntities();
      expect(db.getLines()).toEqual([{ source: a, target: b, type: '-->' }]);
    });

    it('inherits the value into descendant containers', () => {
      parse(
        'auto-sequence on',
        'subprocess S',
        '  task X',
        '  task Y',
      );
      const [s] = db.getEntities();
      const [x, y] = s.children;
      expect(db.getLines()).toEqual([{ source: x, target: y, type: '-->', container: s }]);
    });

    it('lets a nested container opt out with auto-sequence off', () => {
      parse(
        'auto-sequence on',
        'subprocess S',
        '  auto-sequence off',
        '  task X',
        '  task Y',
      );
      expect(db.getLines()).toEqual([]);
    });

    it('never gives an end event an outgoing line', () => {
      parse('auto-sequence on', 'task A', 'end', 'task B');
      const [a, end] = db.getEntities();
      // A is sequenced into the end event, but the end event is a terminus:
      // it is never chained on to B.
      expect(db.getLines()).toEqual([{ source: a, target: end, type: '-->' }]);
    });

    it('never gives a link throw event an outgoing line', () => {
      parse('auto-sequence on', 'task A', 'link throw x', 'task B');
      const [a, x] = db.getEntities();
      // A is sequenced into the link throw (a "go to"), but it is a terminus:
      // it is never chained on to B.
      expect(db.getLines()).toEqual([{ source: a, target: x, type: '-->' }]);
    });

    it('still sequences from a link catch event', () => {
      parse('auto-sequence on', 'link catch x', 'task B');
      const [x, b] = db.getEntities();
      // A link CATCH is an ordinary entry point — it chains on to the next sibling.
      expect(db.getLines()).toEqual([{ source: x, target: b, type: '-->' }]);
    });

    it('sequences a node whose only outgoing line goes to data', () => {
      parse('auto-sequence on', 'task A', 'data D', 'task B', 'A --> D');
      const [a, , b] = db.getEntities();
      // The link to data does not count, so A is still sequenced to B.
      expect(db.getLines()).toEqual([
        { source: 'A', target: 'D', type: '-->' },
        { source: a, target: b, type: '-->' },
      ]);
    });

    it('skips a boundary event, sequencing across it like data', () => {
      parse('auto-sequence on', 'subprocess S', '  task a', '  boundary', '  task b');
      const [s] = db.getEntities();
      const [a, , b] = s.children;
      // The boundary event attaches to the activity, off the flow: a --> b.
      expect(db.getLines()).toEqual([{ source: a, target: b, type: '-->', container: s }]);
    });

    it('sequences a node whose only outgoing line crosses into another pool', () => {
      parse(
        'auto-sequence on',
        'pool P',
        '  lane L',
        '    task A',
        '    task B',
        'pool Q',
        '  lane M',
        '    task C',
        'A --> C',
      );
      const lane = db.getEntities()[0].children[0];
      const [a, b] = lane.children;
      // A --> C crosses into pool Q, so it does not count: A is still sequenced
      // to its in-pool sibling B.
      expect(db.getLines()).toEqual([
        { source: 'A', target: 'C', type: '-->' },
        { source: a, target: b, type: '-->', container: lane },
      ]);
    });
  });

  describe('style / class (tint & shade dropped)', () => {
    it('parses classDef and a bare self-targeting style', () => {
      parse('classDef hot fill:red', 'task A', '  style stroke:blue');
      expect(db.getClassDefs().get('hot')).toEqual({ fill: 'red' });
      expect(db.getEntities()[0].style).toEqual({ stroke: 'blue' });
    });

    it('attaches inline classes and named styles', () => {
      parse('task A:::warn', 'style A fill:red', 'class A cold');
      expect(db.getEntities()[0].classes).toEqual(['warn']);
      expect(db.getNamedStyles().get('A')).toEqual({ fill: 'red' });
      expect(db.getNamedClasses().get('A')).toEqual(['cold']);
    });

    it('ignores dropped tint/shade props', () => {
      parse('classDef hot tint:red', 'style A shade:black');
      expect(db.getClassDefs().size).toBe(0);
      expect(db.getNamedStyles().size).toBe(0);
    });
  });

  describe('route and debug ports (kept)', () => {
    it('tunes a line via a nested route', () => {
      parse('task A', 'task B', 'A --> B', '  route exit:s enter:n');
      expect(db.getLines()[0].routing).toEqual({ exit: 's', enter: 'n' });
    });

    it('applies an entity-wide route default to lines in its subtree', () => {
      parse('subprocess S', '  route bend:z', '  A --> B');
      expect(db.getLines()[0].routing).toEqual({ bend: 'z' });
    });

    it('parses bend:l (a single-corner bridge)', () => {
      parse('task A', 'task B', 'A --> B', '  route bend:l');
      expect(db.getLines()[0].routing).toEqual({ bend: 'l' });
    });

    it('enables the debug-ports overlay at the root', () => {
      parse('debug ports');
      expect(db.getDebugPorts()).toBe(true);
    });

    it('warns and ignores debug ports when nested', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      parse('pool P', '  debug ports');
      expect(db.getDebugPorts()).toBe(false);
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });
  });

  describe('curly mode', () => {
    // Reduces an entity to its name and the names of its direct children.
    const childNames = (e: Entity): string[] => e.children.map((c) => c.name);

    it('defines nesting by braces, ignoring indentation', () => {
      // The classic case: b opens a scope, so c and d (whatever their indent) are
      // its children; e, after the close, resumes under a — b's parent.
      parse(
        'subprocess a',
        '    subprocess b {',
        '  subprocess c',
        '        subprocess d',
        '}',
        '    subprocess e',
      );
      const [a] = db.getEntities();
      expect(childNames(a)).toEqual(['b', 'e']);
      const b = a.children.find((c) => c.name === 'b') as Entity;
      expect(childNames(b)).toEqual(['c', 'd']);
    });

    it('nests scopes with inner braces', () => {
      parse('subprocess b {', 'subprocess c {', 'subprocess d', '}', 'subprocess e', '}');
      const [b] = db.getEntities();
      expect(childNames(b)).toEqual(['c', 'e']);
      const c = b.children.find((x) => x.name === 'c') as Entity;
      expect(childNames(c)).toEqual(['d']);
    });

    it('closes several scopes from one line of braces', () => {
      parse('subprocess b {', 'subprocess c {', 'subprocess d', '} }', 'subprocess f');
      expect(db.getEntities().map((e) => e.name)).toEqual(['b', 'f']);
    });

    it('opens a scope at the diagram root with bpmn {', () => {
      parser.parse(['bpmn {', 'subprocess a', 'subprocess b', '}'].join('\n'));
      expect(db.getEntities().map((e) => e.name)).toEqual(['a', 'b']);
    });

    it('opens a scope on a pool and lays out its lanes by braces', () => {
      parse('pool P {', 'lane L1', 'lane L2', '}');
      const [pool] = db.getEntities();
      expect(childNames(pool)).toEqual(['L1', 'L2']);
    });

    it('leaves a multi-line | label driven by indentation inside a scope', () => {
      parse('subprocess b {', 'subprocess c |', '    line one', '    line two', 'subprocess d', '}');
      const [b] = db.getEntities();
      expect(childNames(b)).toEqual(['c', 'd']);
      expect((b.children.find((x) => x.name === 'c') as Entity).label).toBe('line one\nline two');
    });

    it('attaches a bare style to the item it follows, not the container', () => {
      parse('subprocess b {', 'task x', 'style fill:red', 'task y', '}');
      const [b] = db.getEntities();
      expect((b.children.find((c) => c.name === 'x') as Entity).style).toEqual({ fill: 'red' });
      expect((b.children.find((c) => c.name === 'y') as Entity).style).toBeUndefined();
    });

    it('accepts absolute lines, including chains', () => {
      parse('subprocess b {', 'task x', 'task y', 'task z', 'x --> y --> z', '}');
      expect(db.getLines().length).toBe(2);
    });

    it('flags a relative line in curly mode as an error node', () => {
      parse('subprocess b {', 'task x', '--> x', '}');
      expect(errorLabels().some((l) => /curly mode/.test(l))).toBe(true);
    });

    it('flags a relative complex line in curly mode as an error node', () => {
      parse('subprocess b {', 'task x', 'task y', '--> x --> y', '}');
      expect(errorLabels().some((l) => /curly mode/.test(l))).toBe(true);
    });

    it('flags a { after a non-container declaration as an error node', () => {
      parse('gate g {', '}');
      expect(errorLabels().some((l) => /container declaration/.test(l))).toBe(true);
    });

    it('flags an unmatched closing brace as an error node', () => {
      parse('subprocess a', '}');
      expect(errorLabels().some((l) => /unmatched/.test(l))).toBe(true);
    });

    it('makes a { after an unrecognised keyword an error container holding its children', () => {
      // The typo `subprxocess` is not a container declaration, so `{` opens an error
      // scope; the tasks nest inside the error node (indentation is ignored in curly
      // mode). See the "errors should support curly braces" requirement.
      parser.parse(['bpmn LR', '  subprxocess {', 'task a', 'task b', '}'].join('\n'));
      const [err] = db.getEntities();
      expect(err.type).toBe('error');
      expect(err.label).toMatch(/line 2: .*subprxocess/s);
      expect(err.children.map((c) => [c.name, c.type])).toEqual([
        ['a', 'activity'],
        ['b', 'activity'],
      ]);
    });
  });
});
