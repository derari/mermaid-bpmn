// Mermaid's canonical layout directions. `TD` (top-down) is an alias for `TB`
// used by flowchart; we normalize it away on the way in.
export type Direction = 'TB' | 'BT' | 'LR' | 'RL';

// Every entity has a coarse `type` that fixes its BPMN family. `pool` and `lane`
// are the swimlane containers; `activity`, `gate`, `data`, and `event` are the
// flow elements; `region` is a purely structural grouping box (no border,
// transparent fill); `group` is a visible grouping box (a dash-dot, round-cornered
// border with a caption, but transparent interior); `text` is a text annotation (a
// transparent box with an open bracket on one edge, holding only ports); and `port`
// is a named connection point pinned to one edge of its parent container (realised
// as an ELK port in the renderer rather than a drawn box). `error` is a diagnostic
// node the parser inserts for a line it cannot parse or a line endpoint it cannot
// resolve; it draws as a plain box with an extra-bold red border (see the renderer)
// and carries the diagnostic text as its explicit `label`. Each family carries its
// own optional discriminator fields on the Entity (activityType/taskType/marker,
// gateType, dataType, eventType/…) below.
export type EntityType =
  | 'pool'
  | 'lane'
  | 'activity'
  | 'gate'
  | 'data'
  | 'event'
  | 'region'
  | 'group'
  | 'text'
  | 'port'
  | 'error';

// An activity's shape family. `task` and `call` are atomic (only boundary events
// nest inside them); `subprocess` (alias `process`), `event-subprocess`,
// `call-subprocess`, and `transaction` are expandable containers that hold the same
// children a lane can. `call-subprocess` is a subprocess-shaped container drawn with
// a call activity's bold border.
export type ActivityType =
  | 'task'
  | 'subprocess'
  | 'call'
  | 'call-subprocess'
  | 'event-subprocess'
  | 'transaction';

// The task-type glyph drawn in an activity's corner. Undefined (the default) is an
// abstract task with no glyph.
export type TaskType =
  | 'receive'
  | 'script'
  | 'manual'
  | 'receive-instance'
  | 'service'
  | 'user'
  | 'send'
  | 'rule';

// The multi-instance / loop marker at the bottom of an activity. `instance` is the
// default (a single instance, no marker); `sequential` (alias `multi`) and
// `parallel` are the multi-instance variants; `loop` is the loop marker;
// `compensation` is the compensation marker; `adhoc` is the ad-hoc marker (a tilde).
export type ActivityMarker =
  | 'instance'
  | 'loop'
  | 'sequential'
  | 'parallel'
  | 'compensation'
  | 'adhoc';

// A gateway's kind. `exclusive` (XOR) is the default. `complex` is drawn as an
// asterisk (the exclusive X overlaid on the parallel +).
export type GateType = 'exclusive' | 'inclusive' | 'parallel' | 'event' | 'complex';

// A data element's kind. `object` (a data object) is the default; `store` is a
// data store; `collection` is a data object carrying the multi-instance parallel
// marker (a data-object flavor drawn with three vertical bars).
export type DataType = 'object' | 'store' | 'collection';

// An event's trigger type — the glyph drawn inside the circle. `blank` (the
// default) is an untyped event.
export type EventType =
  | 'blank'
  | 'message'
  | 'timer'
  | 'conditional'
  | 'link'
  | 'signal'
  | 'error'
  | 'escalation'
  | 'termination'
  | 'compensation'
  | 'cancel'
  | 'multiple'
  | 'parallel';

// An event's role in the flow — which selects the circle border style.
// `non-interrupt` is the dashed start/boundary variant; `boundary-non-interrupt`
// is a non-interrupting boundary event.
export type EventOperation =
  | 'start'
  | 'non-interrupt'
  | 'catch'
  | 'boundary'
  | 'boundary-non-interrupt'
  | 'throw'
  | 'end';

// The activity families that are expandable containers: they hold the same
// children a lane can (plus boundary events). `task` and `call` are NOT here —
// they only accept boundary events.
export const ACTIVITY_CONTAINER_TYPES: ReadonlySet<ActivityType> = new Set<ActivityType>([
  'subprocess',
  'call-subprocess',
  'event-subprocess',
  'transaction',
]);

// The two boundary event operations. A boundary event attaches to an activity
// (it is declared as a child of one), which is why an otherwise-atomic activity
// may still contain them.
export const BOUNDARY_OPERATIONS: ReadonlySet<EventOperation> = new Set<EventOperation>([
  'boundary',
  'boundary-non-interrupt',
]);

// The style properties a `style`/`classDef` statement can carry. `fill` paints a
// node's background; `stroke` is the outline color and cascades to descendants and
// to lines written inside them. `icon` is an Iconify-style `pack:name` reference
// drawn on the node; `iconSize` is its size as a factor of the line height
// (1 = one line height, 0/undefined = auto). Like `fill`, `icon`/`iconSize` apply
// to just that node and never cascade to children.
export interface StyleProps {
  fill?: string;
  stroke?: string;
  icon?: string;
  iconSize?: number;
}

// The StyleProps field names, used by the merge helpers (db / styleModel) to copy
// a value per property so later declarations win field-by-field.
export const STYLE_KEYS: ReadonlySet<keyof StyleProps> = new Set<keyof StyleProps>([
  'fill',
  'stroke',
  'icon',
  'iconSize',
]);

// The DSL prop tokens a `style`/`classDef` statement writes, mapped to the
// StyleProps field each fills. `icon-size` is the kebab token for the numeric
// `iconSize` field. The parser builds its `key:` matcher from these tokens and,
// for `iconSize`, parses the value into a number (see parseIconSize).
export const STYLE_PROP_KEYS: ReadonlyMap<string, keyof StyleProps> = new Map<
  string,
  keyof StyleProps
>([
  ['fill', 'fill'],
  ['stroke', 'stroke'],
  ['icon', 'icon'],
  ['icon-size', 'iconSize'],
]);

export interface Entity {
  // The reference id — how the DSL picks this entity out (lines, `style`,
  // `class`, `:::`). May be empty: an entity declared with only a quoted label
  // (`task "Approve"`) or an auto-inserted pool has no name and cannot be
  // referenced.
  name: string;
  // The caption drawn on the diagram, when set explicitly with a quoted label
  // (`task a "Approve"`). Undefined means "no explicit label", so the drawn
  // caption falls back to the family default — see `entityLabel`. An explicit
  // empty string (`task a ""`) suppresses the caption entirely.
  label?: string;
  type: EntityType;
  children: Entity[];
  // Layout direction for THIS entity's children. Undefined means "inherit"
  // (from the enclosing container, ultimately the diagram default).
  direction?: Direction;
  // Whether unlinked flow children of this entity are auto-connected in
  // declaration order (the `auto-sequence on|off` directive). Undefined means
  // "inherit" — from the enclosing container, ultimately the root default (off).
  autoSequence?: boolean;
  // Styles declared directly on this entity by a bare `style` statement nested
  // under it. Left undefined when none, so entity equality in tests is unaffected.
  style?: StyleProps;
  // Class names attached via `:::` on the declaration. Undefined when none.
  classes?: string[];

  // --- family-specific discriminators (all undefined unless the family sets them) ---

  // `activity` only. `activityType` is always set for an activity. `taskType` and
  // `marker` are set only when non-default (an abstract task / single instance).
  activityType?: ActivityType;
  taskType?: TaskType;
  marker?: ActivityMarker;
  // `gate` only. Set only when non-default (not `exclusive`).
  gateType?: GateType;
  // `data` only. Set only when non-default (not `object`).
  dataType?: DataType;
  // `event` only. `eventOperation` is always set for an event; `eventType` is set
  // only when non-default (not `blank`).
  eventType?: EventType;
  eventOperation?: EventOperation;
  // `event` only, and only meaningful for a BOUNDARY event attached to an activity
  // (see BOUNDARY_OPERATIONS): which edge of the host activity the event pins to,
  // realised as a sized ELK port on the activity's border. A compass side pins it
  // there; `auto` (also the default when omitted) derives the side from the host's
  // layout direction (90° clockwise from the flow — see the renderer). Ignored for a
  // boundary event that is NOT a child of an activity (it draws as a normal event).
  boundarySide?: Side | 'auto';
  // `port` only: which edge of its parent container it pins to (the required
  // trailing compass direction of `port <name> <dir>`).
  portSide?: Side;
  // `text` only: which edge draws the open bracket (`comment <id?> <side?>`). A
  // compass side pins it there; undefined means `auto` (the default) — the renderer
  // derives it from the text's first port, else a connected line, else the west edge.
  bracketSide?: Side;
}

// Families whose caption defaults to their reference id when no explicit label is
// given (`task Approve` draws "Approve"). A gateway defaults to no caption — it is
// labelled only when one is set explicitly — as do regions and ports (a port never
// carries one at all; see `entityLabel`).
export const NAME_AS_LABEL_TYPES: ReadonlySet<EntityType> = new Set<EntityType>([
  'pool',
  'lane',
  'activity',
  'data',
  'event',
  'group',
  'text',
]);

// The caption text the renderer should draw for an entity — `''` meaning no
// caption at all. An explicit label (including an explicit empty string) always
// wins; otherwise name-as-label families fall back to their id and everything else
// (gates, regions, ports) to nothing. Ports never draw a caption.
export function entityLabel(entity: Entity): string {
  if (entity.type === 'port') return '';
  if (entity.label !== undefined) return entity.label;
  return NAME_AS_LABEL_TYPES.has(entity.type) ? entity.name : '';
}

// A connection between two entities. `---` is undirected; `-->` points from the
// source to the target; `<--` points the other way (target to source).
export type LineType = '---' | '-->' | '<--';

// A slash (a short diagonal tick) drawn across a line end, from a leading or
// trailing `/` on the connector (`/--`, `--/`, `/-->`, `<--/`). `start` marks the
// source end (a leading `/`), `end` the target end (a trailing `/`), and `both`
// either end. In BPMN a slash near the source is the default-sequence-flow marker.
// It is orthogonal to the arrow direction, so any `LineType` may carry one.
export type SlashEnd = 'start' | 'end' | 'both';

// A box side, in compass terms: north/east/south/west.
export type Side = 'n' | 'e' | 's' | 'w';

// Explicit routing hints a `route` statement attaches to a line. Unlike `style`
// (a CSS-passthrough appearance bag), routing is about layout, so it lives in its
// own field with a validated vocabulary. Every knob is optional; the renderer
// fills in defaults (`exit:auto enter:auto depth:1 bend:auto`) and only ever consults
// routing for a line that crosses a container boundary.
//
//  - `exit`  which side of the crossed container the line leaves; `auto` derives
//            the axis from the container's flow direction and the sign from the
//            target's position.
//  - `enter` which side of the crossed container the line enters on the target
//            side; `auto` faces the source's exit (the side opposite `exit`).
//  - `depth` how many nesting levels get an ELK-routed port (the port chain);
//            the remainder is hand-routed. `0` is fully hand-routed.
//  - `bend`  the hand-routed segment's shape: `z` = HVH, `n` = VHV, `l` = a single
//            corner (HV or VH, the axis taken from the source's exit edge); `auto`
//            picks `l` when the exit and enter edges are perpendicular, else — if an
//            endpoint is pinned to an edge (a port) — the z/n axis of that edge,
//            otherwise the axis the endpoints are more separated along.
export interface RouteSpec {
  exit?: Side | 'auto';
  enter?: Side | 'auto';
  depth?: number | 'auto';
  bend?: 'z' | 'n' | 'l' | 'auto';
}

// A line's endpoints are resolved to entities only at render time, since an
// absolute line may reference an entity declared later in the source.
//
// Each endpoint is either a name (absolute lines: `A --> B`) or a direct entity
// reference. The reference form is used when an endpoint is the enclosing entity
// filling an omitted slot in a relative line (`--> B`).
export interface Line {
  source: Entity | string;
  target: Entity | string;
  type: LineType;
  // A caption drawn along the connection, from a quoted label at the end of the
  // line definition (`A --> B "text"`). Placed near the source. Undefined when
  // none, so line equality in tests is unaffected.
  label?: string;
  // Styles declared on the line by a `style` statement nested under it. Only
  // `stroke` is meaningful for a drawn line; undefined when none.
  style?: StyleProps;
  // A slash decoration at one or both line ends, from a leading/trailing `/` on
  // the connector. Undefined when none, so line equality in tests is unaffected.
  slash?: SlashEnd;
  // The entity a relative line was written inside, whose stroke it inherits.
  // Undefined marks an absolute line, which instead inherits from the lowest
  // common ancestor of its endpoints (computed at render time).
  container?: Entity | null;
  // Layout routing hints from a `route` statement — either nested directly under
  // the line, or an entity-wide default from a `route` in the entity this line was
  // declared in (the line's own keys win). Kept separate from `style` (routing is
  // layout, not appearance) and undefined when none, so line equality in tests is
  // unaffected.
  routing?: RouteSpec;
}

// Module-level state, mirroring how Mermaid's built-in diagrams keep their db.
// `clear()` is called at the start of every parse so renders don't leak into
// each other on a page with multiple diagrams.
//
// The diagram itself is modelled as a `root` container entity: the top-level
// entities are its children, and the diagram-wide direction and style are simply
// ITS OWN direction and style. This is what lets "diagram scope" stop being a
// special case — in the parser it is just the outermost entity (see the root
// frame there), so a diagram-wide `style`/`route`/`direction` reuses the ordinary
// entity machinery. It is a region (borderless, transparent) and is never drawn;
// only its children are, so it stays out of the public API — `getEntities()`
// exposes its children, and `getDirection()`/`getRootStyle()` its own fields.
function makeRoot(): Entity {
  return { name: '', type: 'region', children: [] };
}
let root: Entity = makeRoot();
let lines: Line[] = [];
// When set (via the root-only `debug ports` directive), the renderer draws the
// otherwise-invisible routing ports as small red squares. Off by default. This is
// a diagram-level toggle, not an entity property, so it stays a plain flag.
let debugPorts = false;
// Named style bags from `classDef`, style set on entities by name via
// `style <name> …`, and class assignments from `class <names> <class>`. All are
// resolved against the entity tree at render time.
let classDefs: Map<string, StyleProps> = new Map();
let namedStyles: Map<string, StyleProps> = new Map();
let namedClasses: Map<string, string[]> = new Map();

// Copies one property from `next` onto `out` when set. A generic key keeps the
// value and target types tied to the same field, so a mixed string/number
// StyleProps assigns without a union-index write error.
function copyProp<K extends keyof StyleProps>(out: StyleProps, next: StyleProps, key: K): void {
  if (next[key] !== undefined) out[key] = next[key];
}

// Merges `next` over `base`, ignoring undefined props, so later declarations win
// per-property rather than wholesale.
function mergeStyle(base: StyleProps, next: StyleProps): StyleProps {
  const out: StyleProps = { ...base };
  for (const key of STYLE_KEYS) copyProp(out, next, key);
  return out;
}

export const db = {
  clear(): void {
    root = makeRoot();
    lines = [];
    debugPorts = false;
    classDefs = new Map();
    namedStyles = new Map();
    namedClasses = new Map();
  },

  // The root container entity. The parser uses it as the outermost nesting frame
  // so diagram-scoped statements attach to it like any other entity.
  getRoot(): Entity {
    return root;
  },

  // Adds an entity of the given family as a child of `parent`, or of the root when
  // parent is null. Family-specific fields (activityType, gateType, …) are set by
  // the parser on the returned node. Returns the created node so the parser can use
  // it as a nesting anchor.
  addEntity(name: string, type: EntityType, parent: Entity | null = null): Entity {
    const entity: Entity = { name, type, children: [] };
    (parent ?? root).children.push(entity);
    return entity;
  },

  // Records a connection. Endpoints are stored verbatim and resolved to entities
  // by the renderer, so forward references (`A --> B` before `B` is declared)
  // work. Returns the stored line so the parser can attach a nested `style`/`route`
  // to it afterwards.
  addLine(
    source: Entity | string,
    target: Entity | string,
    type: LineType,
    container: Entity | null = null,
  ): Line {
    const line: Line = { source, target, type };
    // Only relative lines record a container; absolute lines (null) fall back to
    // the endpoints' common ancestor. Kept off the object when null so line
    // equality in tests is unaffected.
    if (container) line.container = container;
    lines.push(line);
    return line;
  },

  getLines(): Line[] {
    return lines;
  },

  // Records a `classDef <name> …`, merging over any earlier definition so a
  // repeated classDef refines rather than replaces.
  addClassDef(name: string, style: StyleProps): void {
    classDefs.set(name, mergeStyle(classDefs.get(name) ?? {}, style));
  },

  getClassDefs(): Map<string, StyleProps> {
    return classDefs;
  },

  // Records a `style <name> …`, merging so several statements for one name
  // accumulate (last value wins per property).
  addNamedStyle(name: string, style: StyleProps): void {
    namedStyles.set(name, mergeStyle(namedStyles.get(name) ?? {}, style));
  },

  getNamedStyles(): Map<string, StyleProps> {
    return namedStyles;
  },

  // Records a `class <names> <class>` assignment, accumulating class names per
  // entity name.
  addNamedClasses(name: string, classNames: string[]): void {
    const existing = namedClasses.get(name) ?? [];
    namedClasses.set(name, [...existing, ...classNames]);
  },

  getNamedClasses(): Map<string, string[]> {
    return namedClasses;
  },

  // The diagram-wide default style: the root entity's own style, set by a bare
  // `style` at the diagram root (the parser attaches it like any bare style). Its
  // inheritable prop (stroke) seeds every top-level entity — the outermost layer,
  // one notch more specific than the theme; `fill` has no root box to paint and
  // does not cascade, so it is inert here.
  getRootStyle(): StyleProps {
    return root.style ?? {};
  },

  // Sets the child-layout direction. `target === null` sets it on the root, which
  // IS the diagram default (top-level entities are the root's children).
  setDirection(direction: Direction, target: Entity | null = null): void {
    (target ?? root).direction = direction;
  },

  getEntities(): Entity[] {
    return root.children;
  },

  getDirection(): Direction {
    return root.direction ?? 'LR';
  },

  // Toggles the `debug ports` overlay (root-only directive).
  setDebugPorts(on: boolean): void {
    debugPorts = on;
  },

  getDebugPorts(): boolean {
    return debugPorts;
  },

  // Accessibility / title hooks Mermaid may call on any db. No-ops for now.
  setAccTitle(): void {},
  getAccTitle(): string {
    return '';
  },
  setAccDescription(): void {},
  getAccDescription(): string {
    return '';
  },
  setDiagramTitle(): void {},
  getDiagramTitle(): string {
    return '';
  },
};

export type BpmnDb = typeof db;
