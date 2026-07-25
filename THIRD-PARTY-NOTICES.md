# Third-party notices

`mermaid-bpmn` is MIT-licensed. It also **bundles and redistributes** third-party
assets under their own licenses, listed here.

## Material Design Icons (MDI-derived glyphs in the `bpmn` pack)

- **What:** the MDI-derived glyphs in the always-available `bpmn` pack
  (`src/bpmnIcons.ts`, compiled into `dist`) — the activity task-type glyphs and
  several event-type markers (see the table). Used for `icon:bpmn:<name>` and as
  the automatic glyphs for BPMN task types and event types. The pack's **gateway**
  markers (`exclusive`/`inclusive`/`parallel`/`event`) and the remaining
  **event-type** markers (`signal`, `escalation`, `cancel`, `multiple`, `parallel`,
  `termination`, in `-in`/`-out` variants) are hand-drawn original SVG covered by
  this project's MIT license, not by the notice below.
- **Source:** Material Design Icons by Pictogrammers —
  <https://github.com/Templarian/MaterialDesign>
- **License:** Apache License 2.0 (SPDX: `Apache-2.0`) — full text in
  [`licenses/mdi-APACHE-2.0.txt`](licenses/mdi-APACHE-2.0.txt).
- **Modifications:** a subset of icons was extracted from MDI and re-keyed to BPMN
  names (some copied under more than one name); the `manual` glyph was rotated 90°
  clockwise. The path data is otherwise unmodified. Regenerate with
  `node scripts/gen-bpmn-icons.mjs`.

| `bpmn` name(s)                     | MDI source name          |
| ------------------------------------- | ------------------------ |
| `receive`, `message-in`               | `envelope-outline`       |
| `send`, `message-out`                 | `envelope`               |
| `script`                              | `script-text-outline`    |
| `manual`                              | `hand-back-left-outline` (rotated 90° cw) |
| `service`                             | `cog-outline`            |
| `user`                                | `person-outline`         |
| `rule`, `conditional-in`              | `view-list-outline`      |
| `conditional-out`                     | `view-list`              |
| `timer-in`                            | `clock-time-four-outline`|
| `timer-out`                           | `clock-time-four`        |
| `link-in`                             | `arrow-right-bold-outline`|
| `link-out`                            | `arrow-right-bold`       |
| `error-in`                            | `flash-outline`          |
| `error-out`                           | `flash`                  |
| `compensation-in`                     | `rewind-outline`         |
| `compensation-out`                    | `rewind`                 |
