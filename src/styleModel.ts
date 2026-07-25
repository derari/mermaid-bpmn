import { type Entity, STYLE_KEYS, type StyleProps } from './db.js';

// Resolves the declared styling (classDef / class / :::, `style <name>`, bare
// `style`, and inheritance) into a concrete fill and outline color per entity.
// Kept free of DOM and ELK so it is unit-tested directly, like geometry.ts; the
// renderer supplies the theme colors and applies the results.

// The theme-derived fallbacks a diagram starts from: the default node `fill` and
// the default outline `stroke`.
export interface ThemeDefaults {
  fill: string;
  stroke: string;
}

// The drawing values for one entity. `strokeExplicit` is the inherited-or-own
// user stroke, if any — separate from `border` (which folds in the theme
// default) because a line only inherits an *explicit* stroke, otherwise using
// its own theme line color.
export interface Resolved {
  fill: string;
  border: string;
  strokeExplicit?: string;
  // The resolved `icon:pack:name` reference, if any. Like `fill` it is a per-node
  // property — taken from the entity's own style bag and never inherited — so a
  // parent's icon doesn't stamp itself on every child. The renderer resolves it to
  // SVG (see icons.ts) and draws it.
  icon?: string;
  // The `icon-size` factor of the line height (0/undefined = auto). Per-node like
  // `icon`; the renderer turns it into a pixel size against the context default.
  iconSize?: number;
}

// Copies one property from `next` onto `out` when set. A generic key ties the
// value and target to the same field, so a mixed string/number StyleProps assigns
// without a union-index write error.
function copyProp<K extends keyof StyleProps>(out: StyleProps, next: StyleProps, key: K): void {
  if (next[key] !== undefined) out[key] = next[key];
}

// Merges `next` over `base`, ignoring undefined props so later layers win
// per-property.
function merge(base: StyleProps, next: StyleProps | undefined): StyleProps {
  if (!next) return base;
  const out: StyleProps = { ...base };
  for (const key of STYLE_KEYS) copyProp(out, next, key);
  return out;
}

// The style an entity declares on itself, lowest-to-highest precedence:
// classes (each class's classDef, in listed order) < `style <name>` < bare
// `style`. Classes come from both `:::` on the declaration and `class`
// statements targeting the name.
function ownStyle(
  entity: Entity,
  classDefs: Map<string, StyleProps>,
  namedStyles: Map<string, StyleProps>,
  namedClasses: Map<string, string[]>,
): StyleProps {
  let bag: StyleProps = {};
  const classes = [
    ...(entity.classes ?? []),
    ...(entity.name ? namedClasses.get(entity.name) ?? [] : []),
  ];
  for (const cls of classes) {
    bag = merge(bag, classDefs.get(cls));
  }
  if (entity.name) bag = merge(bag, namedStyles.get(entity.name));
  bag = merge(bag, entity.style);
  return bag;
}

// Walks the tree top-down, threading the inherited (explicit) stroke, and records
// each entity's drawing values. `fill` is the entity's own flat `fill:` when
// given, else the theme default (a region stays transparent). `stroke` cascades:
// an entity without its own inherits the nearest ancestor's explicit stroke.
export function resolveStyles(
  roots: Entity[],
  classDefs: Map<string, StyleProps>,
  namedStyles: Map<string, StyleProps>,
  namedClasses: Map<string, string[]>,
  theme: ThemeDefaults,
  // Diagram-wide defaults from a root-level bare `style`. They seed the top-level
  // inheritance base — more specific than the theme, less than any entity's own
  // style. Only `stroke` cascades; `fill` never does, so it is inert here.
  rootStyle: StyleProps = {},
): Map<Entity, Resolved> {
  const resolved = new Map<Entity, Resolved>();

  const visit = (entity: Entity, inheritedStroke: string | undefined): void => {
    const own = ownStyle(entity, classDefs, namedStyles, namedClasses);
    const strokeExplicit = own.stroke ?? inheritedStroke;
    // A region, a group, and a text annotation are transparent unless a `fill` is
    // set; every other family falls back to the theme's default node fill. They
    // still thread the inherited stroke down to their children unchanged.
    const transparent =
      entity.type === 'region' || entity.type === 'group' || entity.type === 'text';
    const fill = transparent ? own.fill ?? 'transparent' : own.fill ?? theme.fill;

    // Some families default their icon from the `bpmn` pack when none is set
    // explicitly (an explicit `icon:` — from classDef/class/`style`, folded into
    // `own` above — always wins):
    //   - an activity with a concrete task type → `bpmn:<taskType>`;
    //   - a gateway → its type marker `bpmn:<gateType>` (default `exclusive`);
    //   - an event with a concrete type → `bpmn:<eventType>-<in|out>`, the suffix
    //     being `out` for throwing/ending events and `in` otherwise. A `blank` event
    //     (the default) has no marker.
    // A missing bpmn glyph (e.g. `receive-instance`, or `termination-in`) resolves
    // to nothing and simply draws no icon (icons.ts warns and skips).
    const icon =
      own.icon ??
      (entity.type === 'activity' && entity.taskType
        ? `bpmn:${entity.taskType}`
        : entity.type === 'gate'
          ? `bpmn:${entity.gateType ?? 'exclusive'}`
          : entity.type === 'event' && entity.eventType
            ? `bpmn:${entity.eventType}-${
                entity.eventOperation === 'throw' || entity.eventOperation === 'end' ? 'out' : 'in'
              }`
            : undefined);

    resolved.set(entity, {
      fill,
      border: strokeExplicit ?? theme.stroke,
      strokeExplicit,
      // Non-inheriting, like `fill`: the entity's own resolved icon only.
      icon,
      iconSize: own.iconSize,
    });

    for (const child of entity.children) {
      visit(child, strokeExplicit);
    }
  };

  // The outermost inheritance layer: the root style's stroke over the theme's.
  for (const root of roots) {
    visit(root, rootStyle.stroke);
  }
  return resolved;
}
