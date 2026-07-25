import type { Entity, Line } from './db.js';

// Line validation for ports, kept pure (no ELK, no DOM) so it can be unit-tested
// directly like geometry.ts / routePlan.ts / styleModel.ts. The renderer resolves
// its graph, calls `analysePorts` once, then asks `isInvalidLine` per connection.
//
// A port is a pass-through routing anchor, not a destination — so the one rule
// enforced here is that an arrowhead must never land ON a port. (Richer
// connection validity will return in BPMN terms when flow semantics are added.)

export interface PortValidation {
  // Whether a line is invalid and should be drawn bold red. Unresolved or
  // self-referential lines are never invalid (the renderer skips them with a
  // warning of their own).
  isInvalidLine(line: Line): boolean;
}

export function analysePorts(roots: Entity[], _lines: Line[]): PortValidation {
  // First-declaration-wins name index, mirroring how the renderer resolves
  // endpoints (so validation and drawing agree on who is who).
  const byName = new Map<string, Entity>();
  const visit = (e: Entity): void => {
    if (e.name && !byName.has(e.name)) byName.set(e.name, e);
    e.children.forEach(visit);
  };
  roots.forEach(visit);

  const resolve = (ep: Entity | string): Entity | undefined =>
    typeof ep === 'string' ? byName.get(ep) : ep;
  const isPort = (e: Entity): boolean => e.type === 'port';

  const isInvalidLine = (line: Line): boolean => {
    const a = resolve(line.source);
    const b = resolve(line.target);
    if (!a || !b || a === b) return false;
    // An arrowhead is a destination marker, and a port is a pass-through, not a
    // destination — so any line whose head lands ON a port is invalid. `-->`
    // heads the target, `<--` heads the source.
    if (line.type === '-->' && isPort(b)) return true;
    if (line.type === '<--' && isPort(a)) return true;
    return false;
  };

  return { isInvalidLine };
}
