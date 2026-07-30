# Changelog

All notable changes to `mermaid-bpmn` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[1.1.0]: https://github.com/derari/mermaid-bpmn/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/derari/mermaid-bpmn/releases/tag/v1.0.0
