import { describe, expect, it } from 'vitest';
import type { Entity, Line } from '../src/db.js';
import { applyLayoutCoordinates, bpmnXmlToDomain } from '../src/xml-to-domain.js';

const LAYOUTED = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" xmlns:di="http://www.omg.org/spec/DD/20100524/DI" id="D" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="Process_1" isExecutable="true">
    <bpmn:task id="A" name="A"><bpmn:outgoing>flow0</bpmn:outgoing></bpmn:task>
    <bpmn:task id="B" name="B"><bpmn:incoming>flow0</bpmn:incoming></bpmn:task>
    <bpmn:sequenceFlow id="flow0" sourceRef="A" targetRef="B" />
  </bpmn:process>
  <bpmndi:BPMNDiagram id="BPMNDiagram_Process_1">
    <bpmndi:BPMNPlane id="BPMNPlane_Process_1" bpmnElement="Process_1">
      <bpmndi:BPMNShape id="A_di" bpmnElement="A">
        <dc:Bounds x="25" y="30" width="100" height="80" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="B_di" bpmnElement="B">
        <dc:Bounds x="175" y="30" width="100" height="80" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNEdge id="flow0_di" bpmnElement="flow0">
        <di:waypoint x="125" y="70" />
        <di:waypoint x="150" y="70" />
        <di:waypoint x="175" y="70" />
      </bpmndi:BPMNEdge>
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn:definitions>`;

/** The same document with every namespace bound to a different prefix. */
const RENAMED_PREFIXES = LAYOUTED.replace(/xmlns:bpmndi=/, 'xmlns:d=')
  .replace(/bpmndi:/g, 'd:')
  .replace(/xmlns:dc=/, 'xmlns:c=')
  .replace(/dc:/g, 'c:')
  .replace(/xmlns:di=/, 'xmlns:w=')
  .replace(/di:/g, 'w:');

describe('bpmnXmlToDomain', () => {
  it('reads shape bounds keyed by the referenced element, not the shape id', async () => {
    const { entityBounds } = await bpmnXmlToDomain(LAYOUTED);
    expect([...entityBounds.keys()]).toEqual(['A', 'B']);
    expect(entityBounds.get('A')).toEqual({ x: 25, y: 30, width: 100, height: 80 });
    expect(entityBounds.get('B')).toEqual({ x: 175, y: 30, width: 100, height: 80 });
  });

  it('reads every waypoint of an edge in order, keyed by the referenced flow', async () => {
    const { lineWaypoints } = await bpmnXmlToDomain(LAYOUTED);
    expect([...lineWaypoints.keys()]).toEqual(['flow0']);
    expect(lineWaypoints.get('flow0')).toEqual([
      { x: 125, y: 70 },
      { x: 150, y: 70 },
      { x: 175, y: 70 },
    ]);
  });

  // Namespace prefixes are not fixed by the spec; only the namespace URIs are.
  it('does not care which prefixes the document uses', async () => {
    const { entityBounds, lineWaypoints } = await bpmnXmlToDomain(RENAMED_PREFIXES);
    expect(entityBounds.get('A')).toEqual({ x: 25, y: 30, width: 100, height: 80 });
    expect(lineWaypoints.get('flow0')).toHaveLength(3);
  });

  it('returns empty maps for a document without a diagram section', async () => {
    const { entityBounds, lineWaypoints } = await bpmnXmlToDomain(
      LAYOUTED.replace(/<bpmndi:BPMNDiagram[\s\S]*<\/bpmndi:BPMNDiagram>/, ''),
    );
    expect(entityBounds.size).toBe(0);
    expect(lineWaypoints.size).toBe(0);
  });

  it('skips an edge that has no waypoints', async () => {
    const { lineWaypoints } = await bpmnXmlToDomain(
      LAYOUTED.replace(/<di:waypoint[^>]*\/>/g, ''),
    );
    expect(lineWaypoints.size).toBe(0);
  });

  it('rejects malformed XML instead of silently returning nothing', async () => {
    await expect(bpmnXmlToDomain('<bpmn:definitions')).rejects.toBeTruthy();
  });
});

describe('applyLayoutCoordinates', () => {
  it('writes bounds onto the entity behind each id', async () => {
    const layout = await bpmnXmlToDomain(LAYOUTED);
    const a: Entity = { name: 'A', type: 'activity', children: [] };
    applyLayoutCoordinates(new Map([['A', a]]), new Map(), layout);
    expect(a).toMatchObject({ x: 25, y: 30, width: 100, height: 80 });
  });

  // The id, not the name, is what addresses an entity — names may be empty or
  // duplicated, so an unnamed entity must still receive its coordinates.
  it('writes bounds for an unnamed entity', async () => {
    const layout = await bpmnXmlToDomain(LAYOUTED);
    const unnamed: Entity = { name: '', type: 'activity', children: [] };
    applyLayoutCoordinates(new Map([['A', unnamed]]), new Map(), layout);
    expect(unnamed).toMatchObject({ x: 25, y: 30 });
  });

  it('writes waypoints onto the line behind each flow id', async () => {
    const layout = await bpmnXmlToDomain(LAYOUTED);
    const line: Line = { source: 'A', target: 'B', type: '-->' };
    applyLayoutCoordinates(new Map(), new Map([['flow0', { line }]]), layout);
    expect((line as unknown as { waypoints: unknown }).waypoints).toEqual([
      { x: 125, y: 70 },
      { x: 150, y: 70 },
      { x: 175, y: 70 },
    ]);
  });

  it('leaves entities and lines untouched when the layout has no entry', async () => {
    const layout = await bpmnXmlToDomain(LAYOUTED);
    const a: Entity = { name: 'Z', type: 'activity', children: [] };
    const line: Line = { source: 'A', target: 'B', type: '-->' };
    applyLayoutCoordinates(new Map([['Z', a]]), new Map([['flow9', { line }]]), layout);
    expect(a).not.toHaveProperty('x');
    expect(line).not.toHaveProperty('waypoints');
  });
});
