import { describe, expect, it } from 'vitest';
import { type ModdleElement } from 'bpmn-moddle';
import type { Entity, Line } from '../src/db.js';
import { assignNodeIds, collectFlowNodes, domainToBpmnXml } from '../src/domain-to-xml.js';
import { moddle } from '../src/moddle.js';

const task = (name: string, children: Entity[] = []): Entity => ({
  name,
  type: 'activity',
  children,
});
const gate = (name: string, gateType?: Entity['gateType']): Entity => ({
  name,
  type: 'gate',
  children: [],
  ...(gateType ? { gateType } : {}),
});
const event = (name: string, eventOperation: Entity['eventOperation']): Entity => ({
  name,
  type: 'event',
  children: [],
  eventOperation,
});
const seq = (source: Entity | string, target: Entity | string): Line => ({
  source,
  target,
  type: '-->',
});
const subProcess = (name: string, children: Entity[] = []): Entity => ({
  name,
  type: 'activity',
  activityType: 'subprocess',
  children,
});

describe('collectFlowNodes', () => {
  it('collects flow nodes in document order, descending into containers', () => {
    const a = task('a');
    const b = task('b');
    const region: Entity = { name: 'r', type: 'region', children: [b] };
    expect(collectFlowNodes([a, region]).nodes).toEqual([a, b]);
  });

  it('collects gateways and events alongside activities', () => {
    const a = task('a');
    const g = gate('g');
    const e = event('e', 'end');
    expect(collectFlowNodes([a, g, e]).nodes).toEqual([a, g, e]);
  });

  it('collects data objects and text annotations as flow nodes', () => {
    const a = task('a');
    const data: Entity = { name: 'd', type: 'data', children: [] };
    const text: Entity = { name: 't', type: 'text', children: [] };
    expect(collectFlowNodes([a, data, text]).nodes).toEqual([a, data, text]);
  });

  it('ignores families that are not flow nodes', () => {
    const a = task('a');
    const port: Entity = { name: 'p', type: 'port', children: [] };
    expect(collectFlowNodes([a, port]).nodes).toEqual([a]);
  });

  // A boundary event is declared inside the activity it guards; BPMN expresses
  // the same relation as a flat node carrying an attachedToRef.
  it('records the host of a boundary event', () => {
    const boundary = event('e', 'boundary');
    const host = task('a', [boundary]);
    const { nodes, hostOf } = collectFlowNodes([host]);
    expect(nodes).toEqual([host, boundary]);
    expect(hostOf.get(boundary)).toBe(host);
  });

  it('does not treat a non-boundary event nested in an activity as attached', () => {
    const inner = event('e', 'catch');
    const host = task('a', [inner]);
    expect(collectFlowNodes([host]).hostOf.size).toBe(0);
  });

  it('does not treat a boundary event outside an activity as attached', () => {
    const loose = event('e', 'boundary');
    const lane: Entity = { name: 'l', type: 'lane', children: [loose] };
    expect(collectFlowNodes([lane]).hostOf.size).toBe(0);
  });

  it('records the sub-process a node is declared in', () => {
    const a = task('a');
    const sub = subProcess('sub', [a]);
    const outside = task('b');
    const { scopeOf } = collectFlowNodes([sub, outside]);
    expect(scopeOf.get(a)).toBe(sub);
    expect(scopeOf.has(sub)).toBe(false);
    expect(scopeOf.has(outside)).toBe(false);
  });

  it('records the innermost sub-process of a nested declaration', () => {
    const a = task('a');
    const inner = subProcess('inner', [a]);
    const outer = subProcess('outer', [inner]);
    const { scopeOf } = collectFlowNodes([outer]);
    expect(scopeOf.get(a)).toBe(inner);
    expect(scopeOf.get(inner)).toBe(outer);
  });

  // BPMN scopes are activities. A region or a lane only groups the drawing, so a
  // node inside one still belongs to the process the container itself is in.
  it('sees through layout containers when resolving the scope', () => {
    const a = task('a');
    const region: Entity = { name: 'r', type: 'region', children: [a] };
    const sub = subProcess('sub', [region]);
    expect(collectFlowNodes([sub]).scopeOf.get(a)).toBe(sub);

    const loose = task('b');
    const outerRegion: Entity = {
      name: 'r2',
      type: 'region',
      children: [loose],
    };
    expect(collectFlowNodes([outerRegion]).scopeOf.has(loose)).toBe(false);
  });

  // The event is a flow node of the process its host is in, not of the host.
  it('gives a boundary event the scope of its host', () => {
    const boundary = event('e', 'boundary');
    const host = task('a', [boundary]);
    const sub = subProcess('sub', [host]);
    const { scopeOf } = collectFlowNodes([sub]);
    expect(scopeOf.get(host)).toBe(sub);
    expect(scopeOf.get(boundary)).toBe(sub);
  });

  it('gives a boundary event on a sub-process the scope outside it', () => {
    const boundary = event('e', 'boundary');
    const inner = task('a');
    const sub = subProcess('sub', [inner, boundary]);
    const { scopeOf } = collectFlowNodes([sub]);
    expect(scopeOf.get(inner)).toBe(sub);
    expect(scopeOf.has(boundary)).toBe(false);
  });
});

describe('assignNodeIds', () => {
  it('uses the name when it is non-empty and unique', () => {
    const a = task('a');
    const b = task('b');
    expect([...assignNodeIds([a, b])]).toEqual([
      ['a', a],
      ['b', b],
    ]);
  });

  it('generates an id for an entity with no name', () => {
    const unnamed = task('');
    expect([...assignNodeIds([unnamed]).keys()]).toEqual(['node0']);
  });

  it('generates an id for a duplicated name, keeping the first', () => {
    const first = task('a');
    const second = task('a');
    const ids = assignNodeIds([first, second]);
    expect([...ids.keys()]).toEqual(['a', 'node0']);
    expect(ids.get('a')).toBe(first);
    expect(ids.get('node0')).toBe(second);
  });

  it('never collides with a name that looks like a generated id', () => {
    const collider = task('node0');
    const unnamed = task('');
    expect([...assignNodeIds([collider, unnamed]).keys()]).toEqual(['node0', 'node1']);
  });

  it('generates an id for a name that is not a legal XML id', () => {
    const spaced = task('two words');
    const digit = task('1st');
    expect([...assignNodeIds([spaced, digit]).keys()]).toEqual(['node0', 'node1']);
  });

  // Ids are resolved document-wide, so a task holding one of the wrapper ids
  // would make a flow's sourceRef/targetRef point at the process or the
  // definitions element.
  it('never hands out the ids of the wrapper elements', () => {
    const defs = task('Definitions_auto');
    const process = task('Process_1');
    expect([...assignNodeIds([defs, process]).keys()]).toEqual(['node0', 'node1']);
  });
});

describe('domainToBpmnXml', () => {
  /**
   * Read the serialized document back through the meta model. The exact
   * formatting and entity encoding are moddle's business, so the assertions are
   * made against the structure it produces.
   */
  async function parse(xml: string): Promise<{
    nodes: {
      id?: string;
      type?: string;
      name?: string;
      attachedTo?: string;
      incoming: string[];
      outgoing: string[];
    }[];
    tasks: {
      id?: string;
      name?: string;
      incoming: string[];
      outgoing: string[];
    }[];
    flows: { id?: string; sourceRef?: string; targetRef?: string }[];
  }> {
    const { rootElement } = await moddle().fromXML(xml);
    const process = (rootElement.rootElements as ModdleElement[]).find(
      (element) => element.$type === 'bpmn:Process',
    )!;
    const elements = [
      ...((process.flowElements as ModdleElement[] | undefined) ?? []),
      ...((process.artifacts as ModdleElement[] | undefined) ?? []),
    ];
    const isFlow = (e: ModdleElement): boolean =>
      e.$type === 'bpmn:SequenceFlow' || e.$type === 'bpmn:Association';
    const refs = (element: ModdleElement, key: string): string[] =>
      ((element[key] as ModdleElement[] | undefined) ?? []).map((r) => r.id ?? '');

    const nodes = elements
      .filter((e) => !isFlow(e))
      .map((e) => ({
        id: e.id,
        type: e.$type,
        name: e.name as string | undefined,
        attachedTo: (e.attachedToRef as ModdleElement | undefined)?.id,
        incoming: refs(e, 'incoming'),
        outgoing: refs(e, 'outgoing'),
      }));

    return {
      nodes,
      tasks: nodes
        .filter((e) => e.type === 'bpmn:Task')
        .map(({ id, name, incoming, outgoing }) => ({
          id,
          name,
          incoming,
          outgoing,
        })),
      flows: elements.filter(isFlow).map((e) => ({
        id: e.id,
        sourceRef: (e.sourceRef as ModdleElement | undefined)?.id,
        targetRef: (e.targetRef as ModdleElement | undefined)?.id,
      })),
    };
  }
  async function firstFlowElement(xml: string): Promise<ModdleElement> {
    const { rootElement } = await moddle().fromXML(xml);
    const process = (rootElement.rootElements as ModdleElement[]).find(
      (element) => element.$type === 'bpmn:Process',
    )!;
    return (process.flowElements as ModdleElement[])[0];
  }
  async function flowElementById(xml: string, id: string): Promise<ModdleElement | undefined> {
    const { rootElement } = await moddle().fromXML(xml);
    const roots = (rootElement.rootElements as ModdleElement[]) ?? [];
    const processes = roots.filter((e) => e.$type === 'bpmn:Process');
    for (const process of processes) {
      const flowElements = (process.flowElements as ModdleElement[] | undefined) ?? [];
      const artifacts = (process.artifacts as ModdleElement[] | undefined) ?? [];
      const hit = [...flowElements, ...artifacts].find((e) => e.id === id);
      if (hit) return hit;
    }
    const collaboration = roots.find((e) => e.$type === 'bpmn:Collaboration');
    const messageFlows = (collaboration?.messageFlows as ModdleElement[] | undefined) ?? [];
    return messageFlows.find((e) => e.id === id);
  }

  it('generates a definitions/process skeleton with the BPMN namespaces', async () => {
    const { xml } = await domainToBpmnXml([], []);
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"');
    expect(xml).toContain('<bpmn:process id="Process_1"');

    const { tasks, flows } = await parse(xml);
    expect(tasks).toEqual([]);
    expect(flows).toEqual([]);
  });

  it('serializes a task with its name', async () => {
    const { xml } = await domainToBpmnXml([task('a')], []);
    expect((await parse(xml)).tasks).toMatchObject([{ id: 'a', name: 'a' }]);
  });

  it('serializes explicit labels into BPMN names instead of entity ids', async () => {
    const labeled: Entity = { name: 'task_id', label: 'Approve request', type: 'activity', children: [] };
    const { xml } = await domainToBpmnXml([labeled], []);
    expect((await parse(xml)).tasks).toMatchObject([{ id: 'task_id', name: 'Approve request' }]);
  });

  it('omits BPMN name for unlabeled gateways', async () => {
    const { xml } = await domainToBpmnXml([gate('g', 'exclusive')], []);
    expect((await parse(xml)).nodes).toMatchObject([{ id: 'g', name: undefined }]);
  });

  it('keeps a name that cannot be an XML id out of the id, but not out of the label', async () => {
    const names = ['a&b', 'a<b', 'a"b', 'a b', '1st'];
    const { xml, nodeIds } = await domainToBpmnXml(
      names.map((n) => task(n)),
      [],
    );
    expect([...nodeIds.keys()]).toEqual(['node0', 'node1', 'node2', 'node3', 'node4']);
    expect((await parse(xml)).tasks.map((t) => t.name)).toEqual(names);
  });

  it('gives an unnamed task a generated id so it is never dropped', async () => {
    const { xml, nodeIds } = await domainToBpmnXml([task('')], []);
    expect((await parse(xml)).tasks).toMatchObject([{ id: 'node0' }]);
    expect([...nodeIds.keys()]).toEqual(['node0']);
  });

  it('keeps duplicate names apart by id', async () => {
    const { xml } = await domainToBpmnXml([task('a'), task('a')], []);
    expect((await parse(xml)).tasks).toMatchObject([
      { id: 'a', name: 'a' },
      { id: 'node0', name: 'a' },
    ]);
  });

  it('serializes a sequence flow between two tasks', async () => {
    const a = task('a');
    const b = task('b');
    const line = seq(a, b);
    const { xml, flowIds } = await domainToBpmnXml([a, b], [line]);
    expect((await parse(xml)).flows).toEqual([{ id: 'flow0', sourceRef: 'a', targetRef: 'b' }]);
    expect(flowIds.get('flow0')).toEqual({
      line,
      sourceId: 'a',
      targetId: 'b',
    });
  });

  it('serializes a line label as the BPMN flow name', async () => {
    const a = task('a');
    const b = task('b');
    const line: Line = { source: a, target: b, type: '-->', label: 'happy path' };
    const { xml } = await domainToBpmnXml([a, b], [line]);
    expect((await flowElementById(xml, 'flow0'))?.name).toBe('happy path');
  });

  it('serializes a message-flow label as BPMN messageFlow name', async () => {
    const a = task('a');
    const b = task('b');
    const laneA: Entity = { name: 'L1', type: 'lane', children: [a] };
    const laneB: Entity = { name: 'L2', type: 'lane', children: [b] };
    const poolA: Entity = { name: 'P1', type: 'pool', children: [laneA] };
    const poolB: Entity = { name: 'P2', type: 'pool', children: [laneB] };
    const line: Line = { source: a, target: b, type: '-->', label: 'request' };
    const { xml } = await domainToBpmnXml([poolA, poolB], [line]);
    expect((await flowElementById(xml, 'msg0'))?.name).toBe('request');
  });

  it('marks a source-side slash as default branch on the source node', async () => {
    const a = gate('a', 'exclusive');
    const b = task('b');
    const c = task('c');
    const main: Line = { source: a, target: b, type: '-->', slash: 'start' };
    const other: Line = { source: a, target: c, type: '-->' };
    const { xml } = await domainToBpmnXml([a, b, c], [main, other]);
    expect((await firstFlowElement(xml)).default.id).toBe('flow0');
  });

  it('does not mark a target-side slash as default branch', async () => {
    const a = gate('a', 'exclusive');
    const b = task('b');
    const { xml } = await domainToBpmnXml([a, b], [{ source: a, target: b, type: '-->', slash: 'end' }]);
    expect((await firstFlowElement(xml)).default).toBeUndefined();
  });

  // bpmn-auto-layout traverses the graph through these references; without them
  // it treats every task as a disconnected root and emits no edges at all.
  it('emits incoming/outgoing references on the connected tasks', async () => {
    const a = task('a');
    const b = task('b');
    const { xml } = await domainToBpmnXml([a, b], [seq(a, b)]);
    expect(xml).toContain('<bpmn:outgoing>flow0</bpmn:outgoing>');
    expect(xml).toContain('<bpmn:incoming>flow0</bpmn:incoming>');
    expect((await parse(xml)).tasks).toMatchObject([
      { id: 'a', incoming: [], outgoing: ['flow0'] },
      { id: 'b', incoming: ['flow0'], outgoing: [] },
    ]);
  });

  it('emits one reference per flow when a task branches', async () => {
    const a = task('a');
    const b = task('b');
    const c = task('c');
    const { xml } = await domainToBpmnXml([a, b, c], [seq(a, b), seq(a, c)]);
    const { tasks, flows } = await parse(xml);
    expect(tasks[0].outgoing).toEqual(['flow0', 'flow1']);
    expect(flows).toEqual([
      { id: 'flow0', sourceRef: 'a', targetRef: 'b' },
      { id: 'flow1', sourceRef: 'a', targetRef: 'c' },
    ]);
  });

  it('resolves endpoints given as names', async () => {
    const a = task('a');
    const b = task('b');
    const { xml } = await domainToBpmnXml([a, b], [seq('a', 'b')]);
    expect((await parse(xml)).flows).toEqual([{ id: 'flow0', sourceRef: 'a', targetRef: 'b' }]);
  });

  it('skips a flow whose endpoint is not part of the diagram', async () => {
    const a = task('a');
    const { xml, flowIds } = await domainToBpmnXml([a], [seq(a, task('nope'))]);
    expect((await parse(xml)).flows).toEqual([]);
    expect(flowIds.size).toBe(0);
  });

  it('numbers flow ids consecutively even when a flow is skipped', async () => {
    const a = task('a');
    const b = task('b');
    const { flowIds } = await domainToBpmnXml([a, b], [seq(a, task('nope')), seq(a, b)]);
    expect([...flowIds.keys()]).toEqual(['flow0']);
  });

  // Same document-wide id resolution as above, from the other side.
  it('does not give a flow an id a task already holds', async () => {
    const a = task('flow0');
    const b = task('b');
    const { xml, nodeIds, flowIds } = await domainToBpmnXml([a, b], [seq(a, b)]);
    expect([...nodeIds.keys()]).toEqual(['flow0', 'b']);
    expect([...flowIds.keys()]).toEqual(['flow1']);
    expect((await parse(xml)).flows).toEqual([{ id: 'flow1', sourceRef: 'flow0', targetRef: 'b' }]);
  });

  it('serializes tasks nested in containers', async () => {
    const a = task('a');
    const b = task('b');
    const region: Entity = { name: 'r', type: 'region', children: [b] };
    const { xml } = await domainToBpmnXml([a, region], []);
    expect((await parse(xml)).tasks.map((t) => t.id)).toEqual(['a', 'b']);
  });

  it.each([
    ['exclusive', 'bpmn:ExclusiveGateway'],
    ['inclusive', 'bpmn:InclusiveGateway'],
    ['parallel', 'bpmn:ParallelGateway'],
    ['event', 'bpmn:EventBasedGateway'],
    ['complex', 'bpmn:ComplexGateway'],
  ] as const)('serializes a %s gateway as %s', async (gateType, expected) => {
    const { xml } = await domainToBpmnXml([gate('g', gateType)], []);
    expect((await parse(xml)).nodes).toMatchObject([{ id: 'g', type: expected }]);
  });

  it('serializes a gateway with no explicit type as exclusive', async () => {
    const { xml } = await domainToBpmnXml([gate('g')], []);
    expect((await parse(xml)).nodes).toMatchObject([{ type: 'bpmn:ExclusiveGateway' }]);
  });

  it.each([
    ['start', 'bpmn:StartEvent'],
    ['non-interrupt', 'bpmn:StartEvent'],
    ['catch', 'bpmn:IntermediateCatchEvent'],
    ['throw', 'bpmn:IntermediateThrowEvent'],
    ['end', 'bpmn:EndEvent'],
  ] as const)('serializes a %s event as %s', async (operation, expected) => {
    const { xml } = await domainToBpmnXml([event('e', operation)], []);
    expect((await parse(xml)).nodes).toMatchObject([{ id: 'e', type: expected }]);
  });

  it.each([
    ['message', 'bpmn:MessageEventDefinition'],
    ['timer', 'bpmn:TimerEventDefinition'],
    ['conditional', 'bpmn:ConditionalEventDefinition'],
    ['link', 'bpmn:LinkEventDefinition'],
    ['signal', 'bpmn:SignalEventDefinition'],
    ['error', 'bpmn:ErrorEventDefinition'],
    ['escalation', 'bpmn:EscalationEventDefinition'],
    ['termination', 'bpmn:TerminateEventDefinition'],
    ['compensation', 'bpmn:CompensateEventDefinition'],
    ['cancel', 'bpmn:CancelEventDefinition'],
  ] as const)('serializes a %s event trigger definition', async (eventType, definitionType) => {
    const ev: Entity = {
      name: 'e',
      type: 'event',
      children: [],
      eventOperation: 'catch',
      eventType,
    };
    const { xml } = await domainToBpmnXml([ev], []);
    const element = await firstFlowElement(xml);
    expect(((element.eventDefinitions as ModdleElement[]) ?? []).map((d) => d.$type)).toEqual([
      definitionType,
    ]);
  });

  it.each([
    ['multiple', false],
    ['parallel', true],
  ] as const)('serializes %s trigger markers', async (eventType, parallelMultiple) => {
    const ev: Entity = {
      name: 'e',
      type: 'event',
      children: [],
      eventOperation: 'catch',
      eventType,
    };
    const { xml } = await domainToBpmnXml([ev], []);
    const element = await firstFlowElement(xml);
    expect(((element.eventDefinitions as ModdleElement[]) ?? []).map((d) => d.$type)).toEqual([
      'bpmn:MessageEventDefinition',
      'bpmn:SignalEventDefinition',
    ]);
    expect(element.parallelMultiple).toBe(parallelMultiple);
  });

  it('marks a non-interrupting start event as such', async () => {
    const { xml } = await domainToBpmnXml([event('e', 'non-interrupt')], []);
    const { rootElement } = await moddle().fromXML(xml);
    const process = (rootElement.rootElements as ModdleElement[]).find(
      (element) => element.$type === 'bpmn:Process',
    )!;
    const start = (process.flowElements as ModdleElement[])[0];
    expect(start.isInterrupting).toBe(false);
  });

  // Without attachedToRef the layouter has no way to reach a boundary event: it
  // is deliberately skipped when the graph is walked along sequence flows.
  it('attaches a boundary event to its host activity', async () => {
    const boundary = event('e', 'boundary');
    const host = task('a', [boundary]);
    const { xml } = await domainToBpmnXml([host], []);
    expect((await parse(xml)).nodes).toMatchObject([
      { id: 'a', type: 'bpmn:Task' },
      { id: 'e', type: 'bpmn:BoundaryEvent', attachedTo: 'a' },
    ]);
  });

  it('marks a non-interrupting boundary event as non-cancelling', async () => {
    const boundary = event('e', 'boundary-non-interrupt');
    const host = task('a', [boundary]);
    const { xml } = await domainToBpmnXml([host], []);
    const { rootElement } = await moddle().fromXML(xml);
    const process = (rootElement.rootElements as ModdleElement[]).find(
      (element) => element.$type === 'bpmn:Process',
    )!;
    const attached = (process.flowElements as ModdleElement[])[1];
    expect(attached.cancelActivity).toBe(false);
  });

  it('connects a gateway and an event with sequence flows', async () => {
    const start = event('s', 'start');
    const g = gate('g', 'parallel');
    const end = event('e', 'end');
    const { xml } = await domainToBpmnXml([start, g, end], [seq(start, g), seq(g, end)]);
    expect((await parse(xml)).flows).toEqual([
      { id: 'flow0', sourceRef: 's', targetRef: 'g' },
      { id: 'flow1', sourceRef: 'g', targetRef: 'e' },
    ]);
  });

  describe('artifacts', () => {
    const data = (name: string, dataType?: Entity['dataType']): Entity => ({
      name,
      type: 'data',
      children: [],
      ...(dataType ? { dataType } : {}),
    });
    const comment = (name: string): Entity => ({
      name,
      type: 'text',
      children: [],
    });
    const group = (name: string, children: Entity[] = []): Entity => ({
      name,
      type: 'group',
      children,
    });

    /** The artifacts moddle files under the process when it reads the document back. */
    async function artifactsOf(xml: string): Promise<ModdleElement[]> {
      const { rootElement } = await moddle().fromXML(xml);
      const process = (rootElement.rootElements as ModdleElement[]).find(
        (element) => element.$type === 'bpmn:Process',
      )!;
      return (process.artifacts as ModdleElement[] | undefined) ?? [];
    }

    // A data node and a text annotation each have a BPMN element of their own,
    // which the layouter sizes and places by type.
    it.each([
      [undefined, 'bpmn:DataObjectReference'],
      ['object' as const, 'bpmn:DataObjectReference'],
      ['collection' as const, 'bpmn:DataObjectReference'],
      ['store' as const, 'bpmn:DataStoreReference'],
    ])('serializes a %s data node by its BPMN type', async (dataType, type) => {
      const { xml } = await domainToBpmnXml([data('d', dataType)], []);
      expect((await parse(xml)).nodes).toMatchObject([{ id: 'd', type }]);
    });

    it('serializes a comment as a text annotation carrying its caption', async () => {
      const { xml } = await domainToBpmnXml([comment('note')], []);
      expect((await parse(xml)).nodes).toMatchObject([{ id: 'note', type: 'bpmn:TextAnnotation' }]);
      expect(xml).toContain('<bpmn:text>note</bpmn:text>');
    });

    // The layouter only walks incoming/outgoing, so a connection has to be
    // announced on its endpoints whatever it means in the domain.
    it('serializes a line touching a data node as an association', async () => {
      const a = task('a');
      const d = data('d');
      const { xml, flowIds } = await domainToBpmnXml([a, d], [seq(a, d)]);

      // The generated id records that this one is an association, not a flow.
      expect([...flowIds.keys()]).toEqual(['assoc0']);
      const parsed = await parse(xml);
      expect(parsed.flows).toEqual([{ id: 'assoc0', sourceRef: 'a', targetRef: 'd' }]);
    });

    // A group has no incoming or outgoing in BPMN, so a line to one has nothing
    // to attach to — but it is still reported, and routed from the boxes later.
    it('reports a line that touches a group without serializing it', async () => {
      const a = task('a');
      const g = group('g', [task('b')]);
      const { xml, flowIds } = await domainToBpmnXml([a, g], [seq(a, g)]);
      expect([...flowIds.values()].map((f) => [f.sourceId, f.targetId])).toEqual([['a', 'g']]);
      expect((await parse(xml)).flows).toEqual([]);
      expect((await parse(xml)).nodes.find((n) => n.id === 'a')?.outgoing).toEqual([]);
    });

    it('serializes a group as an artifact with a category value holding its caption', async () => {
      const { xml } = await domainToBpmnXml([group('g', [task('a')])], []);
      expect(xml).toContain('<bpmn:categoryValue id="cat0" value="g" />');
      expect((await artifactsOf(xml)).map((e) => e.$type)).toEqual(['bpmn:Group']);
    });

    it('reports the group a node is drawn inside', async () => {
      const a = task('a');
      const g = group('g', [a]);
      const { parentOf } = await domainToBpmnXml([g], []);
      expect([...parentOf]).toEqual([['a', 'g']]);
    });

    // A group is only drawn when something is inside it, so an empty one must not
    // become the parent of anything either.
    it('skips an ancestor that is not drawn', async () => {
      const a = task('a');
      const inner = group('inner', [a]);
      const { parentOf } = await domainToBpmnXml([group('outer', [inner])], []);
      expect(parentOf.get('a')).toBe('inner');
      expect(parentOf.get('inner')).toBe('outer');
    });

    // A node inside nested boxes claims membership of every one of them, which is
    // what lets the layouter size the outer box around the inner one.
    it('references every enclosing group from a nested member', async () => {
      const a = task('a');
      const { xml } = await domainToBpmnXml([group('outer', [group('inner', [a])])], []);
      const refs = [...xml.matchAll(/<bpmn:categoryValueRef>(\w+)<\/bpmn:categoryValueRef>/g)].map(
        (m) => m[1],
      );
      expect(refs.sort()).toEqual(['cat0', 'cat1']);
    });

    // The layouter refuses a whole document over one artifact it cannot place, so
    // the flow has to be layoutable without them.
    it('leaves artifacts out on request, still reporting their lines', async () => {
      const a = task('a');
      const d = data('d');
      const g = group('g', [a]);
      const { xml, nodeIds, flowIds } = await domainToBpmnXml([g, d], [seq(a, d)], {
        omitArtifacts: true,
      });

      expect(xml).not.toContain('dataObjectReference');
      expect(xml).not.toContain('<bpmn:group');
      // Every box is still reported, so nothing silently disappears.
      expect([...nodeIds.keys()].sort()).toEqual(['a', 'd', 'g']);
      expect([...flowIds.keys()]).toEqual(['assoc0']);
      expect((await parse(xml)).flows).toEqual([]);
    });
  });

  describe('sub-processes', () => {
    /** The flow elements nested directly inside the named sub-process. */
    async function contentsOf(xml: string, id: string): Promise<string[]> {
      const { rootElement } = await moddle().fromXML(xml);
      const process = (rootElement.rootElements as ModdleElement[]).find(
        (element) => element.$type === 'bpmn:Process',
      )!;
      const find = (elements: ModdleElement[]): ModdleElement | undefined => {
        for (const element of elements) {
          if (element.id === id) return element;
          const nested = element.flowElements as ModdleElement[] | undefined;
          const hit = nested && find(nested);
          if (hit) return hit;
        }
        return undefined;
      };
      const sub = find((process.flowElements as ModdleElement[]) ?? []);
      return ((sub?.flowElements as ModdleElement[] | undefined) ?? []).map((e) => e.id ?? '');
    }

    /** Ids of the elements a seeded DI shape marks as expanded. */
    async function expandedIds(xml: string): Promise<string[]> {
      const { rootElement } = await moddle().fromXML(xml);
      const diagrams = (rootElement.diagrams as ModdleElement[] | undefined) ?? [];
      return diagrams.flatMap((d) =>
        (((d.plane as ModdleElement).planeElement as ModdleElement[] | undefined) ?? [])
          .filter((s) => s.isExpanded === true)
          .map((s) => (s.bpmnElement as ModdleElement).id ?? ''),
      );
    }

    it('serializes a container activity as a sub-process', async () => {
      const a = task('a');
      const { xml } = await domainToBpmnXml([subProcess('sub', [a])], []);
      const types = (await parse(xml)).nodes.map((n) => n.type);
      expect(types).toEqual(['bpmn:SubProcess']);
    });

    describe('activities', () => {
      it.each([
        ['task', undefined, 'bpmn:Task'],
        ['call', undefined, 'bpmn:CallActivity'],
        ['subprocess', undefined, 'bpmn:SubProcess'],
        ['event-subprocess', undefined, 'bpmn:SubProcess'],
        ['call-subprocess', undefined, 'bpmn:SubProcess'],
        ['transaction', undefined, 'bpmn:Transaction'],
        ['subprocess', 'adhoc', 'bpmn:AdHocSubProcess'],
      ] as const)(
        'serializes activity type %s (marker %s) as %s',
        async (activityType, marker, expectedType) => {
          const a: Entity = {
            name: 'a',
            type: 'activity',
            children: [],
            activityType,
            ...(marker ? { marker } : {}),
          };
          const { xml } = await domainToBpmnXml([a], []);
          expect((await parse(xml)).nodes).toMatchObject([{ id: 'a', type: expectedType }]);
        },
      );

      it.each([
        ['receive', 'bpmn:ReceiveTask'],
        ['script', 'bpmn:ScriptTask'],
        ['manual', 'bpmn:ManualTask'],
        ['service', 'bpmn:ServiceTask'],
        ['user', 'bpmn:UserTask'],
        ['send', 'bpmn:SendTask'],
        ['rule', 'bpmn:BusinessRuleTask'],
      ] as const)('serializes task type %s as %s', async (taskType, expectedType) => {
        const a: Entity = {
          name: 'a',
          type: 'activity',
          children: [],
          activityType: 'task',
          taskType,
        };
        const { xml } = await domainToBpmnXml([a], []);
        expect((await parse(xml)).nodes).toMatchObject([{ id: 'a', type: expectedType }]);
      });

      it('serializes receive-instance as an instantiating receive task', async () => {
        const a: Entity = {
          name: 'a',
          type: 'activity',
          children: [],
          activityType: 'task',
          taskType: 'receive-instance',
        };
        const { xml } = await domainToBpmnXml([a], []);
        const element = await firstFlowElement(xml);
        expect(element.$type).toBe('bpmn:ReceiveTask');
        expect(element.instantiate).toBe(true);
      });

      it.each([
        ['loop', 'bpmn:StandardLoopCharacteristics', undefined],
        ['sequential', 'bpmn:MultiInstanceLoopCharacteristics', true],
        ['parallel', 'bpmn:MultiInstanceLoopCharacteristics', false],
      ] as const)(
        'serializes marker %s as loop characteristics',
        async (marker, expectedType, isSequential) => {
          const a: Entity = {
            name: 'a',
            type: 'activity',
            children: [],
            activityType: 'task',
            marker,
          };
          const { xml } = await domainToBpmnXml([a], []);
          const element = await firstFlowElement(xml);
          const lc = element.loopCharacteristics as ModdleElement | undefined;
          expect(lc?.$type).toBe(expectedType);
          if (isSequential !== undefined) expect(lc?.isSequential).toBe(isSequential);
        },
      );

      it('serializes compensation marker as compensation activity flag', async () => {
        const a: Entity = {
          name: 'a',
          type: 'activity',
          children: [],
          activityType: 'task',
          marker: 'compensation',
        };
        const { xml } = await domainToBpmnXml([a], []);
        expect((await firstFlowElement(xml)).isForCompensation).toBe(true);
      });
    });

    it('nests the contents of a sub-process inside it', async () => {
      const a = task('a');
      const b = task('b');
      const sub = subProcess('sub', [a, b]);
      const outside = task('c');
      const { xml } = await domainToBpmnXml([sub, outside], [seq(a, b)]);

      // Only the sub-process and the outer task are flow elements of the process.
      expect((await parse(xml)).nodes.map((n) => n.id)).toEqual(['sub', 'c']);
      expect(await contentsOf(xml, 'sub')).toEqual(['a', 'b', 'flow0']);
    });

    it('nests a sub-process inside a sub-process', async () => {
      const a = task('a');
      const inner = subProcess('inner', [a]);
      const { xml } = await domainToBpmnXml([subProcess('outer', [inner])], []);
      expect(await contentsOf(xml, 'outer')).toEqual(['inner']);
      expect(await contentsOf(xml, 'inner')).toEqual(['a']);
    });

    // The layouter draws a sub-process collapsed unless the incoming diagram
    // interchange says otherwise, so a shape carrying the flag is seeded for it.
    it('seeds a DI shape marking a populated sub-process as expanded', async () => {
      const sub = subProcess('sub', [task('a')]);
      const { xml } = await domainToBpmnXml([sub], []);
      expect(await expandedIds(xml)).toEqual(['sub']);
    });

    it('does not mark an empty sub-process as expanded', async () => {
      const { xml } = await domainToBpmnXml([subProcess('sub')], []);
      expect(await expandedIds(xml)).toEqual([]);
      expect(xml).not.toContain('BPMNShape');
    });

    it('never reuses a node or flow id for a seeded shape', async () => {
      const collider = task('shape0');
      const sub = subProcess('sub', [task('a')]);
      const { xml } = await domainToBpmnXml([collider, sub], []);
      const { rootElement } = await moddle().fromXML(xml);
      const shapes =
        (((rootElement.diagrams as ModdleElement[])[0].plane as ModdleElement)
          .planeElement as ModdleElement[]) ?? [];
      expect(shapes.map((s) => s.id)).toEqual(['shape1']);
    });

    // BPMN has no way to express a flow that crosses a sub-process border — the
    // layouter rejects one outright — so it gets no BPMN counterpart. It is
    // still reported, and drawn straight between the two boxes.
    it('gives a sequence flow crossing a sub-process border no BPMN counterpart', async () => {
      const inner = task('a');
      const sub = subProcess('sub', [inner]);
      const outside = task('c');
      const { xml, flowIds } = await domainToBpmnXml(
        [sub, outside],
        [seq(inner, outside), seq(sub, outside)],
      );

      expect([...flowIds.keys()]).toEqual(['flow0', 'flow1']);
      expect((await parse(xml)).flows).toEqual([{ id: 'flow1', sourceRef: 'sub', targetRef: 'c' }]);
      expect(await contentsOf(xml, 'sub')).toEqual(['a']);
    });

    it('reports which sub-process each nested node is drawn in', async () => {
      const a = task('a');
      const inner = subProcess('inner', [a]);
      const outer = subProcess('outer', [inner]);
      const outside = task('c');
      const { parentOf } = await domainToBpmnXml([outer, outside], []);
      expect([...parentOf]).toEqual([
        ['inner', 'outer'],
        ['a', 'inner'],
      ]);
    });

    it('does not report a parent for a node in an empty, collapsed sub-process', async () => {
      // A boundary event is a sibling of its host, so the sub-process holding
      // only that event stays collapsed and draws no box to nest it in.
      const boundary = event('e', 'boundary');
      const sub = subProcess('sub', [boundary]);
      const { parentOf } = await domainToBpmnXml([sub], []);
      expect([...parentOf]).toEqual([]);
    });
  });

  describe('pools and lanes', () => {
    const pool = (name: string, children: Entity[] = []): Entity => ({
      name,
      type: 'pool',
      children,
    });
    const lane = (name: string, children: Entity[] = []): Entity => ({
      name,
      type: 'lane',
      children,
    });

    /** The participants of the collaboration, with the process each points at. */
    async function participantsOf(xml: string): Promise<{ id?: string; processRef?: string }[]> {
      const { rootElement } = await moddle().fromXML(xml);
      const collaboration = (rootElement.rootElements as ModdleElement[]).find(
        (element) => element.$type === 'bpmn:Collaboration',
      );
      return (((collaboration?.participants as ModdleElement[]) ?? []) as ModdleElement[]).map(
        (p) => ({ id: p.id, processRef: (p.processRef as ModdleElement | undefined)?.id }),
      );
    }

    it('makes each pool a participant with a process of its own', async () => {
      const { xml } = await domainToBpmnXml([pool('P1', [lane('A')]), pool('P2')], []);
      const participants = await participantsOf(xml);
      expect(participants.map((p) => p.id)).toEqual(['P1', 'P2']);
      // Even an empty pool gets a process: a collaboration of black boxes alone
      // is rejected outright.
      for (const p of participants) expect(p.processRef).toBeTruthy();
    });

    it('lists a lane member in the lane set of its pool process', async () => {
      const a = task('a');
      const { xml } = await domainToBpmnXml([pool('P', [lane('L', [a])])], []);
      expect(xml).toContain('<bpmn:lane id="L" name="L">');
      expect(xml).toContain('<bpmn:flowNodeRef>a</bpmn:flowNodeRef>');
    });

    // A lane lists the sub-process, not what is nested inside it: those belong to
    // the sub-process's own scope.
    it('lists the sub-process rather than its contents', async () => {
      const inner = task('inner');
      const sub = subProcess('sub', [inner]);
      const { xml } = await domainToBpmnXml([pool('P', [lane('L', [sub])])], []);
      expect(xml).toContain('<bpmn:flowNodeRef>sub</bpmn:flowNodeRef>');
      expect(xml).not.toContain('<bpmn:flowNodeRef>inner</bpmn:flowNodeRef>');
    });

    it('nests a lane inside its lane in a child lane set', async () => {
      const { xml } = await domainToBpmnXml([pool('P', [lane('Outer', [lane('Inner')])])], []);
      expect(xml).toContain('<bpmn:childLaneSet');
      expect(xml).toContain('<bpmn:lane id="Inner"');
    });

    it('turns a connection crossing a pool border into a message flow', async () => {
      const a = task('a');
      const b = task('b');
      const line = seq(a, b);
      const { xml, flowIds } = await domainToBpmnXml(
        [pool('P1', [lane('A', [a])]), pool('P2', [lane('B', [b])])],
        [line],
      );

      expect(xml).toContain('<bpmn:messageFlow id="msg0" sourceRef="a" targetRef="b" />');
      expect(flowIds.get('msg0')).toEqual({
        line,
        sourceId: 'a',
        targetId: 'b',
        messageFlow: true,
      });
    });

    // A line touching the band itself is not expressible, but it is still drawn.
    it('reports a line touching a lane without serializing it', async () => {
      const a = task('a');
      const l = lane('L', [task('b')]);
      const { xml, flowIds } = await domainToBpmnXml([pool('P', [l]), a], [seq(a, l)]);
      expect([...flowIds.values()].map((f) => [f.sourceId, f.targetId])).toEqual([['a', 'L']]);
      expect(xml).not.toContain('bpmn:sequenceFlow');
      expect(xml).not.toContain('bpmn:messageFlow');
    });

    // Anything declared outside every pool travels in a participant of its own,
    // which is deliberately not reported, so no box is ever drawn around it.
    it('files a node outside every pool in an undrawn participant', async () => {
      const loose = task('loose');
      const { xml, nodeIds } = await domainToBpmnXml([pool('P', [lane('A')]), loose], []);
      expect(await participantsOf(xml)).toHaveLength(2);
      expect([...nodeIds.keys()].sort()).toEqual(['A', 'P', 'loose']);
    });

    it('reports each band as the box its contents are drawn in', async () => {
      const a = task('a');
      const { parentOf } = await domainToBpmnXml([pool('P', [lane('L', [a])])], []);
      expect([...parentOf]).toEqual([
        ['a', 'L'],
        ['L', 'P'],
      ]);
    });
  });
});
