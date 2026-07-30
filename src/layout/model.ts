// The diagram-agnostic layout vocabulary. Nothing here mentions a BPMN family
// (activity/gate/event/…) — only the generic notions the layout engine works
// with: a flow direction, a box side, a line kind, and a line's routing config.
// A concrete notation re-exports and builds on these (see db.ts / bpmnStyle.ts).

// The flow direction of a container's layout.
export type Direction = 'TB' | 'BT' | 'LR' | 'RL';

// A line's arrow kind: plain, or an arrowhead at one end.
export type LineType = '---' | '-->' | '<--';

// A box side, in compass terms: north/east/south/west.
export type Side = 'n' | 'e' | 's' | 'w';

// Explicit routing hints a line carries (declared, or inherited from a container).
// Unlike appearance, routing is about layout, so it has its own validated
// vocabulary. Every knob is optional; the router fills defaults
// (`exit:auto enter:auto depth:0 bend:auto`) and only consults routing for a
// line that crosses a container boundary.
//
//  - `exit`  which side of the crossed container the line leaves; `auto` derives
//            the axis from the container's flow direction and the sign from the
//            target's position.
//  - `enter` which side of the crossed container the line enters on the target
//            side; `auto` faces the source's exit (the side opposite `exit`).
//  - `depth` how many nesting levels get an ELK-routed port (the port chain); the
//            remainder is hand-routed. DEFAULTS TO 0 — fully hand-routed, because ELK
//            places a free port where its own edge routing prefers and may squiggle the
//            join, and neither is steerable. `auto` = as many levels as it takes; a
//            number caps it. A power-user knob for when threading the real boundary
//            matters more than the drawn shape.
//  - `bend`  the hand-routed segment's shape: `z` = HVH, `n` = VHV, `l` = a
//            single-corner L that is HV or VH depending on the exit side's
//            orientation; `auto` (the default) picks `l` when the exit and enter
//            edges meet at 90°, otherwise the axis the endpoints are more
//            separated along.
export interface RouteSpec {
  exit?: Side | 'auto';
  enter?: Side | 'auto';
  depth?: number | 'auto';
  bend?: 'z' | 'n' | 'l' | 'auto';
}

// Does a route spec actually CONSTRAIN routing, or is it all defaults? A knob set to its
// DEFAULT means "do the default", so a spec that is empty or all-defaults is
// indistinguishable from no spec. Only a spec with at least one non-default knob is a real
// manual-routing directive: it makes a text line route, and warns when it has nothing to
// tune. Keyed off VALUES, not the mere presence of the object (which a diagram- or
// entity-wide `route` sprays onto every line, defaults included).
//
// For exit/enter/bend the default is `auto`. For `depth` it is 0 (a pure hand-drawn bridge)
// — so `depth:0` is the no-op here, while `depth:auto` (and any other number) is a genuine
// opt-in to the auto-port chain. See RouteSpec above.
export function constrainsRouting(r: RouteSpec | null | undefined): boolean {
  if (!r) return false;
  return (
    (r.exit !== undefined && r.exit !== 'auto') ||
    (r.enter !== undefined && r.enter !== 'auto') ||
    (r.depth !== undefined && r.depth !== 0) ||
    (r.bend !== undefined && r.bend !== 'auto')
  );
}
