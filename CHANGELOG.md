# Changelog

All notable changes to `mermaid-bpmn` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Open SVG editor action.** The examples editor can open the current rendered diagram in a separate tab through a same-origin cached SVG URL. The standalone document supports browser SVG navigation extensions.

## [1.2.0] - 2026-09-09

The library now goes both ways: a second layout engine hands back the BPMN 2.0
document it laid out, and a reader turns an existing BPMN file back into diagram
source. Ports also opened up to every entity family.

### Added

- **`layout auto` — a second layout algorithm.** `layout <algorithm>` is a standalone
  statement at the diagram root (not a token on the `bpmn` header line) and picks the
  engine that positions the diagram: `elk`, the default, or `auto`. `auto` serializes
  the diagram to BPMN 2.0, lets
  [bpmn-auto-layout](https://github.com/bpmn-io/bpmn-auto-layout) position it, and
  draws the result with the same shapes and styling as `elk`. It covers activities,
  gateways and events (boundary events included), expanded sub-processes with their
  contents, data objects and stores, comments, groups and regions, and pools and
  lanes — pools become a BPMN **collaboration**, so a connection crossing a pool
  border is a routed message flow rather than a straight line. Manual ports,
  direction modifiers and the `route` controls stay ELK-only, a line that crosses a
  sub-process border or touches a group, pool or lane is drawn straight, and because
  bpmn-auto-layout sizes every shape from fixed constants a long caption is wrapped
  and ellipsized instead of growing its box. Nested under anything but the root the
  statement is dropped with a warning. See the README for the full list of what
  `auto` handles.
- **`getLastBpmnXml()`** — the layouted BPMN 2.0 document behind the last render,
  exported for a host page that wants to offer it as a download. Only `layout auto`
  produces one.
- **`importBpmnXml(xml, options)`** — read a BPMN 2.0 document and write it out as
  `bpmn` diagram source: the parser in reverse. The output is structure only, with
  `layout auto` on the first line — no styling, `route` or `direction`, since BPMN
  carries nothing this DSL could use. Relations BPMN and the DSL disagree about are
  folded back: a participant's process is unpacked into its pool, a lane claims the
  members it lists, a boundary event moves into the activity it guards, and a group
  recovers its members from category references or the drawn boxes. `braces: true`
  nests with `{ }` instead of indentation; `boundarySides: true` keeps the edge each
  attached event was drawn on rather than letting the renderer derive one. Both
  halves load on demand, so a consumer who only renders diagrams never pulls in the
  meta model.
- **Either order for a boundary event's interrupt marker.** `non-interrupt boundary`
  now reads as a non-interrupting boundary event, the way `boundary non-interrupt`
  already did, and the interrupting default can be spelled out with
  `interrupt boundary` or `boundary interrupt`. The `-ing` forms — `interrupting`,
  `non-interrupting` — are accepted wherever the short ones are.
- **The examples editor gained an `Import BPMN` dialog** — a drop zone or file picker
  for a `.bpmn` file, toggles for curly braces and boundary sides, and a preview of
  the generated source — plus a **download as BPMN** action for the current diagram.

### Changed

- **Ports on every entity.** A `port` is no longer restricted to containers and text
  annotations: every entity family accepts one, so a task, call activity, gateway,
  event, data object, or pool can carry ports too. As a consequence every entity
  declaration except a `port` itself may now open a curly scope with a trailing `{`.
  A port at the diagram root, and a port nested under another port, remain errors.

### Removed

- **Line validation.** Lines are no longer checked for validity, so nothing is drawn
  bold red any more. In particular an arrowhead landing on a port is now an ordinary
  line: `p1 --> p2` between two ports draws like any other flow. Parse errors keep
  their red diagnostic node.

### Fixed

- **Automatic port sides now follow the real layout.** An `auto` exit/enter side was
  derived from declaration order, but ELK reorders siblings freely — a stack of pools
  especially — so ports could face away from the other endpoint and the line looped
  around the whole diagram. The renderer now re-derives the side from the boxes ELK
  actually produced and lays out again. Explicit `route exit:`/`enter:` sides and
  author-declared ports are unaffected.
- **Auto-sequencing no longer chains non-flow entities.** `auto-sequence` skipped data
  elements and boundary events, but a comment, port, region, group, or error
  diagnostic sitting in the container was wired into the implicit flow as if it were a
  step. All of them are excluded now, both as a step of their own and as the
  destination that counts as a node's outgoing line.

## [1.1.0] - 2026-07-30

Diagram syntax gained a brace form, three new ways to write a gateway, and a call
sub-process; the router was rebuilt around a *flat-by-default* model that keeps whole
diagrams on one automatically routed layer.

### Added

- **Curly syntax.** Any container — the diagram root, a pool, lane, region, group, or
  an expandable activity — may end its line with `{` to nest its contents in braces
  instead of by indentation. Inside a brace scope indentation is ignored and a `}`
  closes back to the enclosing container (several may share a line). Multi-line `|`
  labels still read their own indentation; relative lines (`--> B`) are not available
  inside a scope.
- **`call subprocess`** — a call sub-process, drawn with a bold border, holding the
  same children as a `subprocess`.
- **`complex` gateways**, marked with an **asterisk** from the bundled `bpmn` pack.
- **Boolean-operator gate aliases** `xor`, `or`, and `and` for `exclusive`,
  `inclusive`, and `parallel`. Each stands alone or before an optional `gate` — both
  `xor` and `xor gate` parse.
- **`join`** as an alias for an untyped `gate` (optionally `join gate`). An untyped
  gate with more than one incoming line is resolved *after* parsing: it adopts the type
  of the fork it merges, found by walking the flow backwards and matching nested
  fork/join pairs. With no such fork it stays `exclusive`.
- **Inline direction on expandable activities.** `subprocess`, `call subprocess`,
  `event subprocess`, and `transaction` accept a trailing direction token
  (`subprocess Frontend TB`), the way `region` and `group` already did — equivalent to
  a nested `direction` statement.
- **A space after the backslash now forces a line break** in a label, so
  `"Charge \ the card"` reads as two lines. The existing `\n` form is unchanged.
- **Error nodes.** An unparseable line, or a line naming an endpoint that never
  resolves, no longer takes the whole diagram down: it is drawn in place as a
  diagnostic node with an extra-bold red border (`.bpmn-error`), captioned with the
  line number and the offending text. Structural mistakes — a pool below the root, a
  lane inside a lane, a non-boundary event inside a task, a labelled or root-level
  port — are flagged the same way.
- **The `debug ports` overlay now shows what the router is working against:**
  hand-drawn crossing lines in **blue**, every black box outlined in **orange**
  dash-dash-dot-dot, and any interior wrapper the router inserted filled translucent
  **magenta**. Together they explain why a given line came out hand-drawn.

### Changed

- **Routing is flat by default.** The layout engine now keeps a diagram on one layer
  wherever it can, so a line runs through any number of containers as a single
  automatically routed edge. Only containers that must keep their own flow direction —
  every pool, and any container whose direction differs from its parent's *and* which
  holds more than one box — are laid out as **black boxes**, and just those crossings
  are drawn by hand. Diagrams that previously fell back to hand-drawn segments now get
  cleaner orthogonal routing.
- **The dash in `event-subprocess` is optional** — `event subprocess` is the documented
  spelling, and `event-subprocess` still parses.
- **Pools that share a flow direction are stretched to a common length** (the longest
  of the group), so a stack of them lines up flush rather than ragged — matching how
  lanes already tile a pool edge to edge.
- **Internals were split along a notation boundary.** The old `src/renderer.ts` is now
  `src/render.ts` (the orchestrator), `src/bpmnStyle.ts` (everything BPMN-specific),
  and `src/layout/` (a notation-agnostic layout engine that never mentions a BPMN
  family). The published entry point and its types are unchanged.
- The icon generator moved from `scripts/gen-bpmn-icons.mjs` to
  `scripts/generate-bpmn-icons.mjs`; `npm run gen:icons` is unaffected.

### Fixed

- Lines connecting **inner ports** now bend correctly.
- **Pools stack straight.** A pool is no longer shifted along its cross axis to shorten
  the message flows running between it and its neighbours, so a stack of pools shares
  one origin instead of stepping in and out.

## [1.0.0] - 2026-07-26

Initial release — the `bpmn` diagram type for Mermaid 11, covering pools and lanes,
activities and expandable sub-processes, gateways, the full event grid, data objects
and stores, regions, groups, text annotations, ports and boundary events, styling with
classes and named styles, the bundled `bpmn` icon pack, and ELK-based layout with
tunable cross-boundary routing.

[1.2.0]: https://github.com/derari/mermaid-bpmn/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/derari/mermaid-bpmn/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/derari/mermaid-bpmn/releases/tag/v1.0.0
