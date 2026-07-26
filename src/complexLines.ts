import type { Entity, Line, LineType, RouteSpec, SlashEnd, StyleProps } from './db.js';

// A complex line is a chain — `node arrow node arrow node …` of any length —
// linking named entities. Every node references an entity by id (or, for an
// omitted endpoint of a relative line, the enclosing entity directly); there are
// no connector glyphs and nothing is auto-inserted into the tree. The chain simply
// expands to one segment (a simple line) per arrow, wiring each consecutive pair
// of entities.

// One position in a complex line's chain: an entity reference (a name, or a direct
// Entity when an omitted endpoint was filled by the enclosing entity).
export type ChainNode = { entity: Entity | string };

export interface ComplexLineSpec {
  // The chain, interleaved with `arrows`: nodes[0] arrows[0] nodes[1] … nodes[n].
  // There are always at least three nodes (two arrows).
  nodes: ChainNode[];
  arrows: LineType[]; // one per gap; arrows.length === nodes.length - 1
  // Per-gap slash decorations (from a leading/trailing `/` on that arrow),
  // aligned with `arrows`. Undefined, or a sparse entry, when a gap has none.
  slashes?: (SlashEnd | undefined)[];
  // A quoted label at the end of the chain definition. It applies to the FIRST
  // segment only (the others are left unlabelled).
  label?: string;
  // Styles from a `style` nested under the complex line: they set the stroke of
  // every generated segment.
  style?: StyleProps;
  // The enclosing entity for a relative complex line, inherited by the segments'
  // stroke (undefined for an absolute complex line — it uses the endpoints' LCA).
  container?: Entity | null;
  // Routing hints from a `route` statement nested under the complex line. Copied
  // onto every generated segment so a boundary-crossing segment can honor them.
  routing?: RouteSpec;
}

// First-declaration-wins name lookup, matching how the renderer resolves lines.
function nameIndex(roots: Entity[]): Map<string, Entity> {
  const index = new Map<string, Entity>();
  const visit = (e: Entity) => {
    if (e.name && !index.has(e.name)) index.set(e.name, e);
    e.children.forEach(visit);
  };
  roots.forEach(visit);
  return index;
}

// Expands every complex line into one simple line per arrow, wiring consecutive
// entities in the chain. A chain with an unresolvable named endpoint is skipped
// whole with a warning, mirroring how the renderer treats a simple line. The tree
// is never mutated — this dialect inserts no connectors.
export function expandComplexLines(roots: Entity[], specs: ComplexLineSpec[]): Line[] {
  if (specs.length === 0) return [];
  const names = nameIndex(roots);
  const lines: Line[] = [];

  for (const spec of specs) {
    // Resolve every node to a concrete entity. A chain always begins and ends with
    // an entity, and every interior node is an entity too.
    const resolved: (Entity | null)[] = spec.nodes.map((node) =>
      typeof node.entity === 'string' ? names.get(node.entity) ?? null : node.entity,
    );
    const missing = resolved.findIndex((e) => e === null);
    if (missing >= 0) {
      const ref = spec.nodes[missing].entity;
      const label = typeof ref === 'string' ? ref : ref.name || '(unnamed)';
      console.warn(`bpmn: could not expand a complex line at "${label}" (unknown endpoint)`);
      continue;
    }

    // Carries the complex line's own styling onto a generated segment: its stroke,
    // the container it inherits stroke from, and any routing. Kept off the object
    // when absent so generated-line equality (in tests) is unaffected.
    const seg = (source: Entity, target: Entity, type: LineType, slash?: SlashEnd, label?: string): Line => {
      const line: Line = { source, target, type };
      if (slash) line.slash = slash;
      if (label !== undefined) line.label = label;
      if (spec.style) line.style = spec.style;
      if (spec.container) line.container = spec.container;
      if (spec.routing) line.routing = spec.routing;
      return line;
    };

    // One segment per arrow, wiring each consecutive pair of entities and
    // carrying that arrow's own slash decoration. The chain's label rides on the
    // first segment only.
    spec.arrows.forEach((type, i) => {
      lines.push(
        seg(resolved[i] as Entity, resolved[i + 1] as Entity, type, spec.slashes?.[i], i === 0 ? spec.label : undefined),
      );
    });
  }
  return lines;
}
