import { type ModdleElement } from 'bpmn-moddle';
import {
  ACTIVITY_CONTAINER_TYPES,
  BOUNDARY_OPERATIONS,
  type ActivityMarker,
  type ActivityType,
  type Entity,
  type EntityType,
  type EventOperation,
  type EventType,
  type GateType,
  type Line,
  type TaskType,
  entityLabel,
} from './db.js';
import { moddle } from './moddle.js';

/**
 * Minimal BPMN XML serializer for auto-layout.
 * Converts the domain model (Entity[] + Line[]) to BPMN 2.0 XML that
 * bpmn-auto-layout can position.
 *
 * The document is assembled as a bpmn-moddle object graph and serialized by
 * moddle itself, so escaping, namespaces and reference handling follow the
 * meta model instead of string concatenation.
 *
 * Activities, gateways, events, data objects and text annotations are
 * supported, along with the sequence flows and associations between them. No
 * styling is emitted — only structure, because the sole purpose is to obtain
 * coordinates.
 */

export interface BpmnXmlResult {
  xml: string;
  /** BPMN element id -> the entity it was generated for. */
  nodeIds: Map<string, Entity>;
  /** BPMN sequence flow / association / message flow id -> the line it came from. */
  flowIds: Map<string, FlowRef>;
  /**
   * Node id -> the id of the node it is drawn inside: a pool, a lane, an
   * expanded sub-process, or a grouping box. A node with no entry is drawn at
   * the diagram root.
   */
  parentOf: Map<string, string>;
}

export interface FlowRef {
  line: Line;
  sourceId: string;
  targetId: string;
  /** True when the two ends sit in different pools: a BPMN message flow. */
  messageFlow?: boolean;
}

/** The domain families that become BPMN flow nodes. */
const FLOW_NODE_TYPES: ReadonlySet<EntityType> = new Set<EntityType>([
  'activity',
  'gate',
  'event',
  'data',
  'text',
]);

/**
 * The domain families that become a `bpmn:Group`.
 *
 * A group has no members of its own in BPMN: membership is expressed the other
 * way round, by every member pointing at the group's category value. The
 * layouter reads exactly that and sizes the box for us.
 * A region is the same box without the border, so it serializes the same way.
 */
const GROUP_TYPES: ReadonlySet<EntityType> = new Set<EntityType>(['group', 'region']);

/** The domain families that become a swimlane container. */
const BAND_TYPES: ReadonlySet<EntityType> = new Set<EntityType>(['pool', 'lane']);

/**
 * The BPMN element for each gateway kind. bpmn-auto-layout dispatches on
 * `bpmn:Gateway`, so any of these is sized and routed as a diamond; the
 * exclusive one additionally gets its branches balanced.
 */
const GATE_ELEMENTS: Record<GateType, string> = {
  exclusive: 'bpmn:ExclusiveGateway',
  inclusive: 'bpmn:InclusiveGateway',
  parallel: 'bpmn:ParallelGateway',
  event: 'bpmn:EventBasedGateway',
  complex: 'bpmn:ComplexGateway',
};

const EVENT_ELEMENTS: Record<EventOperation, string> = {
  start: 'bpmn:StartEvent',
  'non-interrupt': 'bpmn:StartEvent',
  catch: 'bpmn:IntermediateCatchEvent',
  throw: 'bpmn:IntermediateThrowEvent',
  end: 'bpmn:EndEvent',
  boundary: 'bpmn:BoundaryEvent',
  'boundary-non-interrupt': 'bpmn:BoundaryEvent',
};

/** The BPMN element for each activity family. */
const ACTIVITY_ELEMENTS: Record<ActivityType, string> = {
  task: 'bpmn:Task',
  call: 'bpmn:CallActivity',
  subprocess: 'bpmn:SubProcess',
  'call-subprocess': 'bpmn:SubProcess',
  'event-subprocess': 'bpmn:SubProcess',
  transaction: 'bpmn:Transaction',
};

/** The BPMN task element for each task glyph. */
const TASK_ELEMENTS: Record<TaskType, string> = {
  receive: 'bpmn:ReceiveTask',
  script: 'bpmn:ScriptTask',
  manual: 'bpmn:ManualTask',
  'receive-instance': 'bpmn:ReceiveTask',
  service: 'bpmn:ServiceTask',
  user: 'bpmn:UserTask',
  send: 'bpmn:SendTask',
  rule: 'bpmn:BusinessRuleTask',
};

/** The concrete BPMN event definition for each event trigger type that has one. */
const EVENT_DEFINITION_ELEMENTS: Partial<Record<EventType, string>> = {
  message: 'bpmn:MessageEventDefinition',
  timer: 'bpmn:TimerEventDefinition',
  conditional: 'bpmn:ConditionalEventDefinition',
  link: 'bpmn:LinkEventDefinition',
  signal: 'bpmn:SignalEventDefinition',
  error: 'bpmn:ErrorEventDefinition',
  escalation: 'bpmn:EscalationEventDefinition',
  termination: 'bpmn:TerminateEventDefinition',
  compensation: 'bpmn:CompensateEventDefinition',
  cancel: 'bpmn:CancelEventDefinition',
};

/**
 * Names that can be used verbatim as a BPMN element id.
 *
 * `id` is an XML `ID`, so it has to be an NCName: no spaces, no punctuation
 * beyond `.`, `-` and `_`, and it may not start with a digit. A name that does
 * not qualify gets a generated id instead — otherwise the document would not
 * parse back.
 */
const VALID_ID_RE = /^[A-Za-z_][\w.-]*$/;

/**
 * Ids of the wrapper elements this module emits.
 *
 * XML ids are resolved document-wide, so a node that took one of these would
 * make `sourceRef`/`targetRef` resolve to the process or the definitions
 * element, and the layouter would walk into it and fail.
 */
const DEFINITIONS_ID = 'Definitions_auto';
const PROCESS_ID = 'Process_1';
const COLLABORATION_ID = 'Collaboration_1';

export interface FlowNodes {
  /** Flow nodes in document order. */
  nodes: Entity[];
  /** Grouping boxes (groups and regions) in document order. */
  groups: Entity[];
  /** Pools and lanes in document order. */
  bands: Entity[];
  /** For a boundary event: the activity it is attached to. */
  hostOf: Map<Entity, Entity>;
  /**
   * For a node inside an expandable activity: that activity. A node with no
   * entry belongs to the process it sits in directly. Pools, lanes, regions and
   * groups are transparent here — BPMN scopes are activities, not layout
   * containers.
   */
  scopeOf: Map<Entity, Entity>;
  /**
   * For anything inside a pool: that pool. A node with no entry is outside every
   * pool. A pool owns a `bpmn:Process` of its own, so this is what decides which
   * document scope an element is filed in.
   */
  poolOf: Map<Entity, Entity>;
  /** For a node inside a lane: the innermost lane holding it. */
  laneOf: Map<Entity, Entity>;
  /** For a pool or lane: the lanes declared directly inside it. */
  laneChildren: Map<Entity, Entity[]>;
  /**
   * For a node inside a grouping box, an expandable activity, a lane or a pool:
   * the innermost of those. Unlike `scopeOf` this is about the drawing, so
   * everything that gets a box counts; a node with no entry is drawn at the
   * diagram root.
   */
  drawParentOf: Map<Entity, Entity>;
}

/** Whether an entity is an activity that holds a nested process. */
function isSubProcess(entity: Entity): boolean {
  return (
    entity.type === 'activity' &&
    entity.activityType !== undefined &&
    ACTIVITY_CONTAINER_TYPES.has(entity.activityType)
  );
}

/**
 * Collect the entities that become BPMN elements, in document order,
 * descending into containers.
 *
 * Several relations are recorded on the way down, because each is expressed by
 * nesting in the DSL and by something else entirely in BPMN:
 *
 * - a boundary event is declared inside the activity it guards, but is a flow
 *   node of the scope that activity sits in, carrying an `attachedToRef`;
 * - everything declared inside an expandable activity belongs to that
 *   activity's own process;
 * - a pool owns a process of its own, and a lane claims its members by
 *   listing them rather than containing them;
 * - a grouping box owns nothing at all — its members point back at it — so the
 *   drawing parent is tracked separately from the BPMN scope.
 */
export function collectFlowNodes(entities: Entity[]): FlowNodes {
  const nodes: Entity[] = [];
  const groups: Entity[] = [];
  const bands: Entity[] = [];
  const hostOf = new Map<Entity, Entity>();
  const scopeOf = new Map<Entity, Entity>();
  const poolOf = new Map<Entity, Entity>();
  const laneOf = new Map<Entity, Entity>();
  const laneChildren = new Map<Entity, Entity[]>();
  const drawParentOf = new Map<Entity, Entity>();

  function walk(
    entity: Entity,
    parent: Entity | null,
    scope: Entity | undefined,
    drawParent: Entity | undefined,
    pool: Entity | undefined,
    lane: Entity | undefined,
  ): void {
    const isGroup = GROUP_TYPES.has(entity.type);
    const isBand = BAND_TYPES.has(entity.type);

    if (isBand) {
      bands.push(entity);
      if (drawParent) drawParentOf.set(entity, drawParent);
      if (pool) poolOf.set(entity, pool);
      if (entity.type === 'lane') {
        const owner = lane ?? pool;
        if (owner) {
          const siblings = laneChildren.get(owner);
          if (siblings) siblings.push(entity);
          else laneChildren.set(owner, [entity]);
        }
      }
    } else if (FLOW_NODE_TYPES.has(entity.type) || isGroup) {
      (isGroup ? groups : nodes).push(entity);
      if (parent?.type === 'activity' && isBoundaryEvent(entity)) {
        hostOf.set(entity, parent);
        // The event lives beside its host, not inside it.
        const inherit = <T>(map: Map<Entity, T>): void => {
          const value = map.get(parent);
          if (value !== undefined) map.set(entity, value);
        };
        inherit(scopeOf);
        inherit(drawParentOf);
        inherit(poolOf);
        inherit(laneOf);
      } else {
        if (scope) scopeOf.set(entity, scope);
        if (drawParent) drawParentOf.set(entity, drawParent);
        if (pool) poolOf.set(entity, pool);
        if (lane) laneOf.set(entity, lane);
      }
    }

    const innerScope = isSubProcess(entity) ? entity : scope;
    const innerParent = isSubProcess(entity) || isGroup || isBand ? entity : drawParent;
    const innerPool = entity.type === 'pool' ? entity : pool;
    const innerLane = entity.type === 'lane' ? entity : lane;
    for (const child of entity.children) {
      walk(child, entity, innerScope, innerParent, innerPool, innerLane);
    }
  }

  entities.forEach((entity) => walk(entity, null, undefined, undefined, undefined, undefined));
  return { nodes, groups, bands, hostOf, scopeOf, poolOf, laneOf, laneChildren, drawParentOf };
}

function isBoundaryEvent(entity: Entity): boolean {
  return (
    entity.type === 'event' &&
    entity.eventOperation !== undefined &&
    BOUNDARY_OPERATIONS.has(entity.eventOperation)
  );
}

/**
 * Assign unique BPMN element ids to flow nodes.
 *
 * `Entity.name` is not a usable id on its own: it is empty for entities
 * declared with only a quoted label (`task "Approve"`), it may not be a legal
 * XML id, and nothing stops two entities in the same scope from sharing a name.
 * So a name is only used when it qualifies and is not taken yet; everything
 * else falls back to a generated `node<n>` id.
 */
export function assignNodeIds(nodes: Entity[]): Map<string, Entity> {
  const byId = new Map<string, Entity>();
  const used = new Set<string>([DEFINITIONS_ID, PROCESS_ID, COLLABORATION_ID]);
  let next = 0;

  for (const node of nodes) {
    let id: string;
    if (node.name && VALID_ID_RE.test(node.name) && !used.has(node.name)) {
      id = node.name;
    } else {
      while (used.has(`node${next}`)) next++;
      id = `node${next++}`;
    }
    used.add(id);
    byId.set(id, node);
  }

  return byId;
}

/** The BPMN element type an entity is serialized as. */
function bpmnTypeOf(entity: Entity): string {
  if (entity.type === 'gate') return GATE_ELEMENTS[entity.gateType ?? 'exclusive'];
  if (entity.type === 'event') return EVENT_ELEMENTS[entity.eventOperation ?? 'catch'];
  if (entity.type === 'text') return 'bpmn:TextAnnotation';
  if (entity.type === 'data') {
    return entity.dataType === 'store' ? 'bpmn:DataStoreReference' : 'bpmn:DataObjectReference';
  }
  if (entity.type === 'activity') {
    const activityType = entity.activityType ?? 'task';
    if (entity.marker === 'adhoc' && activityType === 'subprocess')
      return 'bpmn:AdHocSubProcess';
    return TASK_ELEMENTS[entity.taskType] ?? ACTIVITY_ELEMENTS[activityType];
  }
  return 'bpmn:Task';
}

/** Whether an entity is filed among a scope's artifacts rather than its flow elements. */
function isArtifact(entity: Entity): boolean {
  return entity.type === 'text' || GROUP_TYPES.has(entity.type);
}

/** Whether a line touching this entity is an association rather than a sequence flow. */
function isAnnotation(entity: Entity): boolean {
  return entity.type === 'data' || entity.type === 'text';
}

export interface BpmnXmlOptions {
  /**
   * Leave data objects, text annotations, groups and their associations out of
   * the document. The layouter refuses a document it cannot find a
   * collision-free spot for every artifact in, and it refuses it whole — so
   * this is the retry that keeps the rest of the diagram laid out. The omitted
   * entities are still reported, and drawn from the fallbacks.
   */
  omitArtifacts?: boolean;
}

export async function domainToBpmnXml(
  entities: Entity[],
  lines: Line[],
  options: BpmnXmlOptions = {},
): Promise<BpmnXmlResult> {
  const { omitArtifacts = false } = options;
  const m = moddle();
  const { nodes, groups, bands, hostOf, scopeOf, poolOf, laneOf, laneChildren, drawParentOf } =
    collectFlowNodes(entities);
  const nodeIds = assignNodeIds([...nodes, ...groups, ...bands]);

  // Generated ids are handed out from one pool, because XML ids are resolved
  // document-wide: a reference to `flow0` finds a node named `flow0` just as
  // happily as the sequence flow it was meant for.
  const taken = new Set<string>([...nodeIds.keys(), DEFINITIONS_ID, PROCESS_ID, COLLABORATION_ID]);
  const nextId = (prefix: string): string => {
    let n = 0;
    while (taken.has(`${prefix}${n}`)) n++;
    taken.add(`${prefix}${n}`);
    return `${prefix}${n}`;
  };

  const idOf = new Map<Entity, string>();
  const elementOf = new Map<Entity, ModdleElement>();
  const groupSet = new Set(groups);
  const pools = bands.filter((band) => band.type === 'pool');
  const withLabel = (entity: Entity): { name?: string } => {
    const label = entityLabel(entity);
    return label ? { name: label } : {};
  };

  /**
   * Which document scope an element is filed in: the sub-process that holds it,
   * or the pool whose process it belongs to, or undefined for the root process.
   * A sub-process and a pool are different entities, so one map covers both.
   */
  const fileIn = (entity: Entity): Entity | undefined =>
    scopeOf.get(entity) ?? poolOf.get(entity) ?? undefined;

  const contentOf = new Map<Entity | undefined, ModdleElement[]>();
  const artifactOf = new Map<Entity | undefined, ModdleElement[]>();
  const listFor = (
    map: Map<Entity | undefined, ModdleElement[]>,
    scope: Entity | undefined,
  ): ModdleElement[] => {
    const existing = map.get(scope);
    if (existing) return existing;
    const created: ModdleElement[] = [];
    map.set(scope, created);
    return created;
  };
  const contentsFor = (scope: Entity | undefined): ModdleElement[] => listFor(contentOf, scope);
  const artifactsFor = (scope: Entity | undefined): ModdleElement[] => listFor(artifactOf, scope);

  // A group's caption is not an attribute but a reference to a shared category
  // value, so the values are collected into one category root element. The same
  // value is what every member points back at to claim its membership.
  const categoryValues: ModdleElement[] = [];
  const categoryOf = new Map<Entity, ModdleElement>();

  for (const [id, entity] of nodeIds) {
    idOf.set(entity, id);

    if (BAND_TYPES.has(entity.type)) {
      // A pool becomes a participant plus a process of its own, a lane a member
      // of that process's lane set. Both are assembled once the contents are
      // known, so only the element itself is created here.
      const element = m.create(entity.type === 'pool' ? 'bpmn:Participant' : 'bpmn:Lane', {
        id,
        ...withLabel(entity),
      });
      elementOf.set(entity, element);
      continue;
    }

    if (groupSet.has(entity)) {
      if (omitArtifacts) continue;
      // A group owns nothing: it is its MEMBERS that point at its category
      // value, and the layouter sizes the box from them. A group with no
      // members is dropped further down, because the layouter would warn about
      // it and emit no shape.
      const element = m.create('bpmn:Group', { id });
      const value = m.create('bpmn:CategoryValue', {
        id: nextId('cat'),
        value: entityLabel(entity),
      });
      categoryValues.push(value);
      categoryOf.set(entity, value);
      element.categoryValueRef = value;
      elementOf.set(entity, element);
      continue;
    }

    if (omitArtifacts && isAnnotation(entity)) continue;

    const element = m.create(bpmnTypeOf(entity), { id, ...withLabel(entity) });
    // A text annotation carries its caption as an element, not an attribute.
    if (entity.type === 'text') element.text = entityLabel(entity);
    // A non-interrupting event is the dashed variant of its ring: on a start
    // event BPMN spells that `isInterrupting`, on a boundary `cancelActivity`.
    if (entity.eventOperation === 'non-interrupt') element.isInterrupting = false;
    if (entity.eventOperation === 'boundary-non-interrupt') element.cancelActivity = false;
    if (entity.activityType === 'event-subprocess') element.triggeredByEvent = true;
    if (entity.type === 'event' && entity.eventType) {
      const def = EVENT_DEFINITION_ELEMENTS[entity.eventType];
      if (def) {
        const definition = m.create(def, { id: nextId('eventDef') });
        element.eventDefinitions = [definition];
      } else if (entity.eventType === 'multiple' || entity.eventType === 'parallel') {
        const defs = [
          m.create('bpmn:MessageEventDefinition', { id: nextId('eventDef') }),
          m.create('bpmn:SignalEventDefinition', { id: nextId('eventDef') }),
        ];
        element.eventDefinitions = defs;
      }
      if (
        entity.eventType === 'parallel' &&
        (entity.eventOperation === 'start' ||
          entity.eventOperation === 'non-interrupt' ||
          entity.eventOperation === 'catch' ||
          entity.eventOperation === 'boundary' ||
          entity.eventOperation === 'boundary-non-interrupt')
      ) {
        element.parallelMultiple = true;
      }
    }
    if (entity.type === 'activity') {
      switch (entity.marker as ActivityMarker | undefined) {
        case 'loop':
          element.loopCharacteristics = m.create('bpmn:StandardLoopCharacteristics');
          break;
        case 'sequential':
          element.loopCharacteristics = m.create('bpmn:MultiInstanceLoopCharacteristics', {
            isSequential: true,
          });
          break;
        case 'parallel':
          element.loopCharacteristics = m.create('bpmn:MultiInstanceLoopCharacteristics', {
            isSequential: false,
          });
          break;
        case 'compensation':
          element.isForCompensation = true;
          break;
      }
      if (entity.taskType === 'receive-instance') element.instantiate = true;
    }
    elementOf.set(entity, element);
    (isArtifact(entity) ? artifactsFor : contentsFor)(fileIn(entity)).push(element);
  }

  // Group membership, the BPMN way round: every node inside a grouping box
  // references that box's category value, and a node inside nested boxes
  // references all of them. A box no node ended up in is dropped — the layouter
  // warns about one it cannot resolve and emits no shape for it.
  const liveGroups = new Set<Entity>();
  for (const node of nodes) {
    const refs: ModdleElement[] = [];
    for (let a = drawParentOf.get(node); a; a = drawParentOf.get(a)) {
      if (!groupSet.has(a)) continue;
      liveGroups.add(a);
      const value = categoryOf.get(a);
      if (value) refs.push(value);
    }
    const element = elementOf.get(node);
    if (element && refs.length > 0) element.categoryValueRef = refs;
  }
  for (const group of groups) {
    const element = elementOf.get(group);
    if (element && liveGroups.has(group)) artifactsFor(fileIn(group)).push(element);
  }

  // A boundary event is not reached by following sequence flows — the layouter
  // finds it through its host, so the attachment has to be wired up before it
  // can place either.
  for (const [entity, host] of hostOf) {
    const element = elementOf.get(entity);
    const hostElement = elementOf.get(host);
    if (element && hostElement) element.attachedToRef = hostElement;
  }

  // Name lookup for line endpoints given as strings.
  const byName = new Map<string, Entity>();
  for (const node of [...nodes, ...groups, ...bands]) {
    if (node.name && !byName.has(node.name)) byName.set(node.name, node);
  }

  const resolve = (endpoint: Entity | string): Entity | undefined => {
    if (typeof endpoint === 'string') return byName.get(endpoint);
    return idOf.has(endpoint) ? endpoint : byName.get(endpoint.name);
  };

  // bpmn-auto-layout walks the graph via each flow node's `outgoing` references,
  // so sourceRef/targetRef alone is not enough — the incoming/outgoing element
  // references have to be serialized as well, or the flows are never followed
  // and every node ends up as its own disconnected root. Setting them on the
  // model makes moddle emit the matching <bpmn:incoming>/<bpmn:outgoing> tags.
  const flowIds = new Map<string, FlowRef>();
  const messageFlows: ModdleElement[] = [];
  const lineName = (line: Line): { name?: string } =>
    line.label && line.label.length > 0 ? { name: line.label } : {};
  const isDefaultAtSource = (line: Line): boolean =>
    line.slash === 'start' || line.slash === 'both';

  const addRef = (element: ModdleElement, property: string, flow: ModdleElement): void => {
    const list = (element[property] as ModdleElement[] | undefined) ?? [];
    list.push(flow);
    element[property] = list;
  };

  for (const line of lines) {
    const source = resolve(line.source);
    const target = resolve(line.target);
    if (!source || !target) continue;

    const sourceId = idOf.get(source);
    const targetId = idOf.get(target);
    if (!sourceId || !targetId) continue;

    const sourceElement = elementOf.get(source);
    const targetElement = elementOf.get(target);

    // Which pool an endpoint speaks for: a pool speaks for itself, everything
    // else for whichever pool holds it. Crossing a pool boundary makes the
    // connection a message flow, which lives in the collaboration rather than in
    // either process.
    const speaksFor = (entity: Entity): Entity | undefined =>
      entity.type === 'pool' ? entity : poolOf.get(entity);
    const crossesPool = speaksFor(source) !== speaksFor(target);

    // A group and a lane are boxes drawn around other things rather than nodes
    // wired to anything, so BPMN gives a line touching one no counterpart. (A
    // pool is the exception: a participant is a legal message flow endpoint.)
    // The same goes for a connection crossing a sub-process border: the layouter
    // rejects one outright. All of them are still reported, and drawn straight
    // between the two boxes once those have been placed.
    const unwireable = (entity: Entity): boolean =>
      groupSet.has(entity) || entity.type === 'lane' || (entity.type === 'pool' && !crossesPool);

    // A line touching a data object or a text annotation is an association in
    // BPMN: dotted, and drawn without an arrowhead.
    const association = isAnnotation(source) || isAnnotation(target);

    const flowId = nextId(crossesPool ? 'msg' : association ? 'assoc' : 'flow');
    flowIds.set(flowId, { line, sourceId, targetId, messageFlow: crossesPool || undefined });

    // An endpoint left out of the document has nothing to attach to.
    if (!sourceElement || !targetElement) continue;
    if (unwireable(source) || unwireable(target)) continue;

    if (crossesPool) {
      if (pools.length > 0) {
        messageFlows.push(
          m.create('bpmn:MessageFlow', {
            id: flowId,
            ...lineName(line),
            sourceRef: sourceElement,
            targetRef: targetElement,
          }),
        );
      }
      continue;
    }

    if (scopeOf.get(source) !== scopeOf.get(target)) continue;

    const scope = fileIn(source);
    if (association) {
      const assoc = m.create('bpmn:Association', {
        id: flowId,
        ...lineName(line),
        sourceRef: sourceElement,
        targetRef: targetElement,
      });
      artifactsFor(scope).push(assoc);
      continue;
    }

    const flow = m.create('bpmn:SequenceFlow', {
      id: flowId,
      ...lineName(line),
      sourceRef: sourceElement,
      targetRef: targetElement,
    });
    if (isDefaultAtSource(line)) sourceElement.default = flow;
    addRef(sourceElement, 'outgoing', flow);
    addRef(targetElement, 'incoming', flow);
    contentsFor(scope).push(flow);
  }

  // Nest each sub-process's own contents inside it. Only flow elements make it
  // a box worth drawing: an artifact alone is never laid out.
  const expanded: ModdleElement[] = [];
  const expandedScopes = new Set<Entity>();
  for (const scope of new Set([...contentOf.keys(), ...artifactOf.keys()])) {
    if (!scope || scope.type === 'pool') continue;
    const element = elementOf.get(scope);
    if (!element) continue;
    const contents = contentOf.get(scope) ?? [];
    const artifacts = artifactOf.get(scope) ?? [];
    if (artifacts.length > 0) element.artifacts = artifacts;
    if (contents.length === 0) continue;
    element.flowElements = contents;
    expanded.push(element);
    expandedScopes.add(scope);
  }

  /**
   * Build the lane set of one pool.
   *
   * A lane does not contain its members in BPMN: it lists them, and only those
   * that are flow nodes of the process itself — everything deeper belongs to the
   * sub-process holding it, which is listed in the lane instead. A lane holding
   * lanes nests them in a child lane set.
   */
  const buildLaneSet = (owner: Entity): ModdleElement | undefined => {
    const children = laneChildren.get(owner);
    if (!children || children.length === 0) return undefined;
    const lanes = children.map((lane) => {
      const element = elementOf.get(lane)!;
      const members = nodes
        .filter(
          (node) =>
            laneOf.get(node) === lane && !scopeOf.has(node) && !isArtifact(node) && !isData(node),
        )
        .map((node) => elementOf.get(node))
        .filter((el): el is ModdleElement => el !== undefined);
      if (members.length > 0) element.flowNodeRef = members;
      const childSet = buildLaneSet(lane);
      if (childSet) element.childLaneSet = childSet;
      return element;
    });
    return m.create('bpmn:LaneSet', { id: nextId('laneSet'), lanes });
  };

  /** Wrap one scope's contents in a `bpmn:Process`. */
  const makeProcess = (owner: Entity | undefined, id: string): ModdleElement => {
    const process = m.create('bpmn:Process', {
      id,
      isExecutable: true,
      flowElements: contentsFor(owner),
      artifacts: artifactsFor(owner),
    });
    const laneSet = owner ? buildLaneSet(owner) : undefined;
    if (laneSet) process.laneSets = [laneSet];
    return process;
  };

  const rootElements: ModdleElement[] = [];
  let rootPlaneElement: ModdleElement;

  if (pools.length > 0) {
    // Every participant gets a process of its own, even an empty pool: a
    // collaboration whose participants all lack a `processRef` is rejected, and
    // an empty process is what makes an empty pool an ordinary sized box rather
    // than a black box.
    const participants: ModdleElement[] = [];
    let n = 0;
    for (const pool of pools) {
      const process = makeProcess(pool, `${PROCESS_ID}_${n++}`);
      rootElements.push(process);
      const participant = elementOf.get(pool)!;
      participant.processRef = process;
      participants.push(participant);
    }

    // Anything declared outside every pool has nowhere to go in a collaboration,
    // so it travels in a participant of its own. That participant is never
    // mapped to an entity, so its box is not drawn — the nodes inside it simply
    // end up in a band of their own.
    if (contentsFor(undefined).length > 0 || artifactsFor(undefined).length > 0) {
      const process = makeProcess(undefined, PROCESS_ID);
      rootElements.push(process);
      participants.push(
        m.create('bpmn:Participant', { id: nextId('loose'), name: '', processRef: process }),
      );
    }

    const collaboration = m.create('bpmn:Collaboration', {
      id: COLLABORATION_ID,
      participants,
      messageFlows,
    });
    rootElements.unshift(collaboration);
    rootPlaneElement = collaboration;
  } else {
    const process = makeProcess(undefined, PROCESS_ID);
    rootElements.push(process);
    rootPlaneElement = process;
  }

  if (categoryValues.length > 0) {
    // A category has to precede the elements referencing it, or the document
    // does not validate.
    rootElements.unshift(
      m.create('bpmn:Category', {
        id: nextId('Category_'),
        categoryValue: categoryValues,
      }),
    );
  }
  const definitions = m.create('bpmn:Definitions', {
    id: DEFINITIONS_ID,
    targetNamespace: 'http://bpmn.io/schema/bpmn',
    rootElements,
  });

  // bpmn-auto-layout draws a sub-process collapsed unless it is told otherwise,
  // and the only way to tell it is a DI shape carrying `isExpanded`: it reads
  // the flag off the incoming diagram interchange and only then discards it.
  // The bounds are ignored, so a zero box is enough to carry the flag. Every
  // shape needs an id of its own, because the flag is looked up through the
  // document-wide id index.
  if (expanded.length > 0) {
    definitions.diagrams = [
      m.create('bpmndi:BPMNDiagram', {
        id: nextId('BPMNDiagram_'),
        plane: m.create('bpmndi:BPMNPlane', {
          id: nextId('BPMNPlane_'),
          bpmnElement: rootPlaneElement,
          planeElement: expanded.map((element) =>
            m.create('bpmndi:BPMNShape', {
              id: nextId('shape'),
              bpmnElement: element,
              isExpanded: true,
              bounds: m.create('dc:Bounds', {
                x: 0,
                y: 0,
                width: 0,
                height: 0,
              }),
            }),
          ),
        }),
      }),
    ];
  }

  const { xml } = await m.toXML(definitions, { format: true });
  return { xml, nodeIds, flowIds, parentOf: buildParentOf() };

  /**
   * Resolve each drawn box to the box it is drawn inside.
   *
   * The declared parent is not always drawn: a sub-process with no flow
   * elements stays collapsed, and a grouping box with no members has nothing to
   * span. Either way the chain is followed further up until a box that does get
   * drawn is found, so a node is never nested in something invisible. A pool or
   * a lane is always drawn.
   */
  function buildParentOf(): Map<string, string> {
    const drawn = (entity: Entity): boolean =>
      BAND_TYPES.has(entity.type)
        ? true
        : groupSet.has(entity)
          ? liveGroups.has(entity)
          : expandedScopes.has(entity);

    const parentOf = new Map<string, string>();
    for (const entity of [...nodes, ...groups, ...bands]) {
      if (groupSet.has(entity) && !liveGroups.has(entity)) continue;
      for (let a = drawParentOf.get(entity); a; a = drawParentOf.get(a)) {
        if (!drawn(a)) continue;
        parentOf.set(idOf.get(entity)!, idOf.get(a)!);
        break;
      }
    }
    return parentOf;
  }
}

/** Whether an entity is a data object or data store: a flow element, not a flow node. */
function isData(entity: Entity): boolean {
  return entity.type === 'data';
}
