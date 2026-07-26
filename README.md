# mermaid-bpmn

A [BPMN (Business Process Model and Notation)](https://www.bpmn.org/) diagram
type for [Mermaid](https://mermaid.js.org/), shipped as an external diagram plugin.
It draws the full BPMN vocabulary — pools and lanes, activities, gateways, events,
data objects, groups, and text annotations. Try it in the
[live editor](https://derari.github.io/mermaid-bpmn/editor).

## Usage

```js
import mermaid from 'mermaid';
import bpmn from 'mermaid-bpmn';

mermaid.registerExternalDiagrams([bpmn]);
mermaid.initialize({ startOnLoad: true });
```

````
```bpmn
bpmn
  task Approve
```
````

renders a slightly rounded rectangle labelled **Approve**.

## Syntax

### Activities

An activity is the workhorse box — a task or sub-process. It is drawn as a
**slightly rounded rectangle** with its label centred, and declared as:

```
<marker?> <task-type?> <activity-type> <id?> "<label?>"
```

Only the **activity type** is required. **Indentation nests** entities — a child
indented under an expandable activity (or a region/lane) becomes its content:

````
```bpmn
bpmn
  subprocess Fulfil
    task Pick
    task Pack
```
````

**Activity types** fix the shape family and what may nest inside:

| Activity type                  | What it is                | May contain                                                |
|--------------------------------|---------------------------|------------------------------------------------------------|
| `task`                         | an atomic task            | boundary events only                                       |
| `call`                         | a call activity           | boundary events only                                       |
| `subprocess` (alias `process`) | an expandable sub-process | activities, gateways, data, events, regions, groups, ports |
| `event-subprocess`             | an event sub-process      | same as `subprocess`                                       |
| `transaction`                  | a transaction             | same as `subprocess`                                       |

**Task types** are an optional prefix that marks a task's kind. When an activity
has a task type but **no explicit [`icon`](#icons)**, the matching glyph from the
always-available [`bpmn`](#the-bpmn-icon-pack) icon pack is drawn
automatically:

| Task type          | Auto icon (`bpmn:…`)   |
|--------------------|------------------------|
| *(undefined)*      | *(none — the default)* |
| `receive`          | `receive`              |
| `send`             | `send`                 |
| `script`           | `script`               |
| `manual`           | `manual`               |
| `service`          | `service`              |
| `user`             | `user`                 |
| `rule`             | `rule`                 |

So `user task Approve` draws a person glyph beside "Approve"; add an explicit
`icon:` to override the automatic one.

**Markers** are an optional leading token for the marker drawn along the
activity's bottom edge: `instance` (the default — a single instance, no marker),
`loop`, `sequential` (alias `multi`), `parallel`, `compensation`, and `ad-hoc`.

````
```bpmn
bpmn
  parallel service task Charge "Charge card"
```
````

### Pools and lanes

A `pool` is a top-level container for a process, drawn as a **sharp-cornered
rectangle**. It is declared at the diagram root:

```
pool <id?> "<label?>" <direction?>
```

An **empty pool** — one with no lanes — is a **fixed size** (eight activity widths
by two activity heights for a horizontal flow, swapped for a vertical one) with its
label **centred**:

````
```bpmn
bpmn LR
  pool "Order handling"
```
````

A pool holds **lanes** (`lane <id?> "<label?>" <direction?>`). A lane may also be
written at the diagram root, where an unnamed pool is inserted around it. A lane
**inherits the pool's flow direction**, and its label behaves like the pool's. An
empty lane (no activities) takes the same fixed size as an empty pool.

When a pool has lanes, its label moves into a **band on the flow's start edge** and
the lanes fill the rest, stacked **across** the flow with no padding:

- **`LR`** — the pool label sits in a band on the **left**, rotated 90° CCW; the
  lanes stack **top-to-bottom** to its right. Each lane in turn puts its own label
  in a left band and flows its activities left-to-right.
- **`RL` / `TB` / `BT`** — the same arrangement, rotated: the band moves to the
  right / top / bottom edge, and the lanes stack along the perpendicular axis.

````
```bpmn
bpmn LR
  pool "Order process"
    lane "Customer"
      task Submit
      task Confirm
      Submit --> Confirm
    lane "Warehouse"
      task Pick
      task Ship
      Pick --> Ship
```
````

Lanes are stretched to a common length so they tile the pool edge to edge.

### Gateways

A `gate` is a gateway, drawn as a **diamond** (a rotated square) with a **type
marker** inside it:

```
<gate-type?> gate <id?> "<label?>"
```

The gate type — `exclusive` (the default), `inclusive`, `parallel`, or `event` —
selects the marker, drawn from the always-available [`bpmn`](#the-bpmn-icon-pack)
pack: an **X** (exclusive), a **ring** (inclusive), a **plus** (parallel), or a
**pentagon** (event). An explicit [`icon`](#icons) overrides it.

````
```bpmn
bpmn
  gate g1
  inclusive gate g2
  parallel gate g3
  event gate g4
```
````

A gateway is a leaf (it holds no children). Wire it with [lines](#lines) to fork
and join flow:

````
```bpmn
bpmn
  gate fork
  task A
  task B
  gate join
  fork --> A
  fork --> B
  A --> join
  B --> join
```
````

### Events

An `event` is a circle. Its **outline** encodes the event's role in the flow
(the operation), and a **marker** inside encodes its trigger (the type):

```
<event-type?> <event-operation> <id?> "<label?>"
```

The **operation** sets the outline:

| Operation                                            | Outline                                        |
|------------------------------------------------------|------------------------------------------------|
| `start`                                              | thin single circle                             |
| `non-interrupt` (alias `continue`)                   | thin **dashed** single circle                  |
| `catch` / `throw`                                    | thin **double** circle (an intermediate event) |
| `boundary`                                           | thin double circle                             |
| `boundary non-interrupt` (alias `boundary continue`) | **dashed double** circle                       |
| `end`                                                | **thick** single circle                        |

For `start`/`end` the id defaults to `start`/`end`. Four **additional operations**
— `termination`, `error`, `cancel`, `escalation` — are shorthand for an end event
of that type (no separate type prefix), and their id defaults to that word.

The **type** picks the marker, drawn from the always-available
[`bpmn`](#the-bpmn-icon-pack) pack in a **catching** (`-in`) or **throwing**
(`-out`) variant — the `-out` form is used for `throw`/`end` operations, `-in`
otherwise. `blank` (the default) has no marker. Types: `message`, `timer`,
`conditional`, `link`, `signal`, `error`, `escalation`, `termination`,
`compensation`, `cancel`, `multiple`, `parallel`. An explicit [`icon`](#icons)
overrides the automatic marker.

````
```bpmn
bpmn
  message start received
  timer catch wait
  error boundary onError
  signal throw published
  end done
```
````

### Names and labels

Every entity has a **name** — the reference the DSL uses to pick it out ([lines](#lines),
`style <name>`, `class`, `:::`) — and a **label**, the caption drawn on the chart.
For an activity they default to the same: `task Approve` is named `Approve` and
drawn "Approve". To separate them, add a **quoted label** after the id; the
bareword stays the reference, the quoted string is what's printed:

````
```bpmn
bpmn
  task charge "Charge card"
```
````

is referenced as `charge` but drawn "Charge card". Quotes fence the label, so it
may contain spaces, arrows, or punctuation without the [whitespace hazard](#lines)
a bare multi-word id has; `\"` and `\\` escape a literal quote or backslash inside
it. The three forms, for the caption-drawing families (`activity`, `data`, `pool`,
`lane`, `text`):

| Declaration        | Name (reference) | Drawn caption                                       |
|--------------------|------------------|-----------------------------------------------------|
| `task Approve`     | `Approve`        | "Approve" (name is the default label)               |
| `task a "Approve"` | `a`              | "Approve"                                           |
| `task "Approve"`   | *(none)*         | "Approve" — no name, so it can't be referenced      |
| `task a ""`        | `a`              | *(none)* — an explicit empty label draws no caption |

A `region`, `gate`, and `event` default to an **empty** caption (a region's name
is styling-only; gateways and events label sparingly) — give one an explicit
quoted label to draw a caption. A `port` never carries a label.

#### Line breaks and multi-line labels

Inside a quoted label a literal `\n` forces a **line break**, and the whitespace
flanking it is gobbled, so `"Charge  \n  the card"` draws as two lines with no
stray spaces. (Write `\\n` — an escaped backslash then `n` — for a literal `\n`.)

For a longer caption, drop the quotes and end the declaration with a `|` marker;
the label is then the block of **more-indented lines** that follow. The first such
line fixes the label's base indent, deeper lines keep their extra spaces, and the
label ends at the first line indented back below it (a line still under the entity,
but shallower than the label, nests as a child as usual). The `|` works anywhere a
quoted label does, and sits in the same spot — before any `:::class` or trailing
direction:

````
```bpmn
bpmn
  subprocess Bob | :::bob-style
      Multi line label
      First line defines indent
        This line has two spaces
      More...
    task Nested in Bob
```
````

### Groups

A `group` is the visible counterpart to a region: BPMN's **group** notation, a
box with a **dash-dot border** and **rounded corners**, drawn around a set of
entities to call them out without implying they belong to a common pool or
sub-process. Its interior stays transparent (unless given a `fill`) so it never
obscures what it wraps.

It parses exactly like a region — `group <id?> "<label?>" <direction?> :::<class?>`
— and holds the same children. The one difference in defaults is the caption: a
group **draws its name** (like a lane or activity), so `group Review` is labelled
"Review". Give it a quoted [label](#names-and-labels) to override, or `""` to
suppress the caption. Like regions, groups are structural and are never
[line](#lines) endpoints.

````
```bpmn
bpmn LR
  auto-sequence
  start
  group Review
    task Validate
    task Approve
  task Archive
  end
```
````

### Text annotations

A `comment` is a BPMN **text annotation**: a **transparent box** carrying a
caption, with a bold, open **bracket** drawn on one edge. It is declared like a
region, but its trailing token is a **compass side** (which edge the bracket sits
on) rather than a layout direction:

```
comment <id?> "<label?>" <side?>  :::<class?>
```

The side takes `n`/`north` `e`/`east` `s`/`south` `w`/`west` (case-insensitive), or
`auto` / `?` — the **default**. Under `auto` the bracket edge is chosen from, in
order: the side of the annotation's **first [port](#ports)**, else the side facing
the **first entity it is [linked](#lines) to**, else the **west** edge.

The box is transparent unless a [`fill`](#colors) is set. Like a
[label](#names-and-labels)-drawing family the caption defaults to the id (use `""`
to suppress it), and the `\n` escape and `|` [multi-line](#line-breaks-and-multi-line-labels)
label both apply. A text annotation **holds only [ports](#ports)**, and is wired to
the entity it annotates with an undirected `---` [line](#lines). A line touching a
text annotation is drawn **dotted**, like a [data association](#lines) — including
when it is routed through a declared [port](#ports) on the annotation:

````
```bpmn
bpmn LR
  task Review
  comment note "Double-check the totals" w
  Review --- note
```
````

### Lines

Lines connect two entities. Three arrows set the direction: `---` is a plain
link, `-->` points at the second entity, and `<--` points at the first.
Whitespace must surround the arrows so it never swallows a hyphen from a name.
Either end may also carry a [slash](#line-end-slashes), and the line may take a
[label](#line-labels).

An **absolute line** names both endpoints — `entity1 arrow entity2` — and may
appear anywhere in the diagram; its nesting is irrelevant, so it reads the same
wherever you put it:

````
```bpmn
bpmn LR
  task A
  task B
  task C
  A --- B
  B --> C
  C <-- A
```
````

A **relative line** drops one endpoint and lets the entity it is nested under
fill the gap. Drop the *first* endpoint (`arrow entity2`) and the enclosing
entity is the source; drop the *second* (`entity1 arrow`) and it is the target:

````
```bpmn
bpmn LR
  subprocess Stage
    task Inner
    Inner -->
    --> Done
  task Done
```
````

Endpoints are resolved by name after the whole diagram is parsed, so an absolute
line may reference an entity declared further down. A line whose endpoints don't
resolve is skipped with a console warning rather than failing the render. Lines may
cross container boundaries and are routed through the nesting accordingly (see
[Cross-boundary routing](#cross-boundary-routing)).

#### Line labels

A **quoted label** at the *end* of a line definition is drawn along the
connection, placed near the **source** end. It uses the same quoting as an entity
label — the `\n` escape and `\"`/`\\` escapes all apply:

````
```bpmn
bpmn LR
  start
  exclusive gate check "Approved?"
  task Approve
  task Reject
  start --> check "submit"
  check --> Approve "yes"
  check /--> Reject "no"
```
````

The layout engine reserves room for the label and keeps it clear of the boxes, so
labelling a line can nudge the diagram to make space. On a
[complex line](#complex-lines) the label applies to the **first segment only**
(`A --> B --> C "x"` labels `A --> B`).

#### Line-end slashes

A `/` on either end of the connector draws a short **diagonal slash** across the
line there — near the source with a **leading** `/`, near the target with a
**trailing** `/`. A leading slash is BPMN's **default-sequence-flow** marker (the
branch a gateway falls through to). It is independent of the arrowhead, so it
combines with any direction; the only combination that is *not* allowed is a
double arrow (`<-->`), so a `/` and an arrowhead never share the same end:

| Connector | Slash        | Arrow            |
|-----------|--------------|------------------|
| `/--`     | source       | none             |
| `--/`     | target       | none             |
| `/-->`    | source       | at second entity |
| `<--/`    | target       | at first entity  |
| `/--/`    | both ends    | none             |

````
```bpmn
bpmn LR
  start
  exclusive gate check "Approved?"
  task Approve
  task Reject
  start --> check
  check --> Approve
  check /--> Reject
```
````

Slashes work on relative and [complex](#complex-lines) lines too, where each
arrow carries its own.

### Complex lines

A **complex line** is a chain of two or more arrows threaded through a run of
**named entities** — `A arrow B arrow C arrow …` — expanding to one plain line
per arrow. Entities are linked **by id only**; the chain has no length limit and
each arrow is independent, and either endpoint may be omitted just as in a plain
relative line (the enclosing entity fills the gap):

````
```bpmn
bpmn LR
  task A
  task B
  task C
  A --> B --> C
```
````

expands to `A --> B` and `B --> C`. Whitespace must flank an arrow next to a name,
so a hyphen inside a name is never mistaken for a connector.

## Styling

### Colors

Out of the box the diagram follows the active Mermaid **theme**. Set it the usual
way — `mermaid.initialize({ theme, themeVariables })`, or per-diagram with an
`%%{init}%%` directive — and bpmn reads its palette from there: node fill from
`mainBkg`, entity outlines from `nodeBorder`, lines from `lineColor`, and labels
from `textColor`. No bpmn-specific configuration is required.

Two color style properties can be set explicitly, both taking any whitespace-free
CSS color (`#f90`, `tomato`, `rgb(255,0,0)`, `hsl(9,100%,64%)`):

| Property | Effect                                                    | Inherited by children? |
|----------|-----------------------------------------------------------|:----------------------:|
| `fill`   | flat background for **one** node                          |           no           |
| `stroke` | outline color — and the color of lines written inside it  |          yes           |

(`icon` and `icon-size`, below, are style properties too.)

#### Applying styles

A **`style` statement** carries one or more `key:value` props (split on spaces,
commas, or semicolons). Named, it targets every entity with that name; bare (no
name), it styles the entity — or line — it is **nested under**:

````
```bpmn
bpmn TB
  subprocess Web Server
    task Request Handler
    task Auth Module
  task Database
  Web Server --> Database

  style Web Server  stroke:#c62828
  style Auth Module fill:#ffd54f
  style Database    fill:#2e7d32
```
````

A bare `style` at the **diagram root** (a sibling of the top-level entities) sets
a **diagram-wide default**. It is the outermost styling layer — one notch more
specific than the theme — so its inheritable prop (`stroke`) seeds every entity
unless a nearer declaration overrides it. (`fill` never cascades, so it does
nothing at the root.)

**`classDef` / `class` / `:::`** work as in flowchart: define a reusable bag with
`classDef <name> <props>`, then attach it with `class <names> <name>` (names
comma-separated, the class name last) or the `entity:::name` shorthand on a
declaration:

````
```bpmn
bpmn
  classDef critical fill:#ffcdd2 stroke:#b71c1c
  task Payments:::critical
  task Archive
  class Archive critical
```
````

Precedence, most specific first: a node's own `fill`/`icon` > its bare `style` >
`style <name>` > `class`/`classDef` > inherited `stroke` > the diagram-root
`style` default > the theme.

#### Line color

A line takes its `stroke` from, in order: a `style` nested under it; the entity a
**relative** line is written inside (or, for an **absolute** line, the container
that encloses both endpoints); otherwise the theme line color. Nest the `style`
under the line to set it directly — and on a complex line, that same `style` colors
every generated segment:

````
```bpmn
bpmn LR
  task Producer
  task Consumer
  Producer --> Consumer
    style stroke:#00897b
```
````

An **invalid** line (an arrowhead on a port) is always bold red, ignoring any
`stroke`.

### Icons

An entity can carry an **icon** drawn from an [Iconify](https://iconify.design/)
icon pack. `icon` is just another [style property](#colors), so it rides the same
machinery as the colors — set it with a bare `style`, `style <name>`, a
`classDef`/`class`, or the `:::` shorthand — and, like `fill`, it applies to **one
node** and never cascades to children. Its value is an Iconify `pack:name`
reference:

````
```bpmn
bpmn LR
  task web "Web Server"
    style icon:lucide:server
  task db "Database"
    style icon:lucide:database
  web --> db
```
````

Every entity that draws a caption can carry an icon (all but a `port`). It is
drawn at **one line height, before the label** — to its left in a leaf, in the top
label band of a container — or, when there is no label, where the label would go.
As a special case, a box with **no label and no children** draws the icon **alone
at twice the line height**, centred (use an explicit empty label, `task a ""`, to
get one).

Recall that an [activity with a task type](#activities) gets its icon
automatically from the `bpmn` pack unless an explicit `icon:` overrides it.

#### The `bpmn` icon pack

The `bpmn` pack is **always registered** — no setup needed — and holds the
[task-type](#activities) glyphs (`icon:bpmn:user`, …), the [gateway](#gateways)
markers (`icon:bpmn:exclusive`, …), and the [event](#events) markers in `-in`/
`-out` variants (`icon:bpmn:message-in`, `icon:bpmn:signal-out`, …). The
message/timer/conditional/link/error/compensation glyphs are borrowed from
[Material Design Icons](https://github.com/Templarian/MaterialDesign) (Apache-2.0);
the gateway and remaining event markers are hand-drawn (MIT). See
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). Regenerate the pack with
`npm run gen:icons`.

#### Icon size

`icon-size` sets the icon's size as a factor of the line height. It is a
[style property](#colors) like `icon` — same `style`/`class` machinery, same
per-node (non-cascading) behaviour — and takes:

| Value                       | Factor                                        |
|-----------------------------|-----------------------------------------------|
| `auto` (or `?`)             | the context default — **this is the default** |
| `s` / `m` / `l`             | 1 / 2 / 3× line height                        |
| `xl`, `xxl`, `xxxl`, …      | 4, 5, 6… — each leading `x` on `l` adds one   |
| a number (`1.5`, `.7`, `2`) | that many line heights                        |

Values are case-insensitive. The box grows to reserve room for the icon, and when
a large icon sits beside a label the label is **vertically centred to the icon**.

#### Registering icon packs

Beyond the built-in pack, icons resolve against packs you register once, up front.
`registerIconPacks` accepts Iconify packs either eagerly (their JSON in hand) or
via a lazy `loader` — the loader runs only on the first diagram that actually uses
an icon from that pack, so an icon-free page fetches nothing:

```js
import mermaid from 'mermaid';
import bpmn, { registerIconPacks } from 'mermaid-bpmn';

mermaid.registerExternalDiagrams([bpmn]);
registerIconPacks([
  {
    name: 'lucide',
    loader: () => import('@iconify-json/lucide/icons.json', { with: { type: 'json' } })
      .then((m) => m.default),
  },
]);
```

An `icon:` that names an unregistered pack, a missing icon, or a value without a
`pack:` prefix is skipped with a console warning rather than failing the render.

## Controlling layout & routing

Layout and line routing are **automatic**, and most diagrams need nothing from this
section. When the automatic result isn't what you want, these are the manual
controls — reach for them only when you need to steer it:

- set the overall or per-container **flow direction**;
- group boxes together for layout without drawing anything — **regions**;
- pin the exact point where a line touches a container — **ports**;
- tune how a line is **routed** when it crosses between containers.

Each is described below; the deeper routing knobs live in
[docs/routing.md](docs/routing.md).

### Layout direction

Set the diagram's flow direction on the header, the same way flowchart does
(`flowchart LR`). Tokens are Mermaid's `TB`/`TD`, `BT`, `LR`, `RL`, plus the
aliases `vertical` (→ `TB`) and `horizontal` (→ `LR`):

````
```bpmn
bpmn LR
  task A
  task B
```
````

A `direction` statement nested inside a container overrides the flow for that
container's children only — mirroring `direction` inside a flowchart subgraph:

````
```bpmn
bpmn LR
  subprocess Frontend
    direction TB
    task UI
    task Router
  subprocess Backend
    direction TB
    task API
    task Worker
```
````

A container can flow differently from its parent; a line that crosses between
two differently-flowing containers is routed for you, and can be tuned — see
[Cross-boundary routing](#cross-boundary-routing).

### Regions

A `region` is a structural grouping box with no visual presence of its own: it
draws no border and is transparent unless given a `fill`. Use it to lay a group of
entities out together — for example on their own axis — without adding a box to the
picture. A region adds no chrome (no border, no padding, no label band), so
wrapping entities in one never shifts them.

It takes an optional inline layout direction as its last token (`region LR`,
`region My Group RL`); a nested `direction` statement works too. Here `Alice` and
`Bob` sit side by side, with `Carol` below:

````
```bpmn
bpmn TB
  region LR
    task Alice
    task Bob
  region
    task Carol
```
````

Give a region a `fill` to color the area around its children (sibling regions tile
their parent's interior edge to edge), or a quoted [label](#names-and-labels) to
draw it as a heading. A region's name is otherwise undrawn — it exists so
[styling](#colors) can target it (`style My Group fill:#eef`, `:::class`, or a
`class` statement). Regions are structural, so they are never [line](#lines)
endpoints.

### Ports

A `port` is a named connection point pinned to **one edge of its parent
container**. It draws nothing itself; its whole job is to give [lines](#lines) a
fixed spot on a container's boundary to enter or leave through. It is declared with
a **required trailing direction** — a compass side, `n`/`north`, `e`/`east`,
`s`/`south`, `w`/`west` (case-insensitive) — after an optional name:

````
```bpmn
bpmn LR
  subprocess Service
    port Out e
    task Worker
    Worker --- Out
  task Database
  Out --> Database
```
````

Here `Worker --- Out` runs from inside `Service` to a port on its **east** edge,
and `Out --> Database` carries on from that same point to the sibling activity.

A few rules:

- **A port lives on a container, never at the diagram root** — there is no edge to
  pin to there, so a root-level `port` is a parse error.
- **A port holds nothing but lines.** Its name lets a line reference it, but it is
  never drawn, so nesting an entity under a port, or giving one a quoted
  [label](#names-and-labels), is a parse error.
- **An arrowhead may never land on a port.** A port is a pass-through, not a
  destination, so a `-->` whose target is a port (or a `<--` whose source is one)
  is **invalid** — drawn **bold red**. Wire ports with undirected `---` lines, or
  point the arrow at the entity on the *far* side.

To see where ports land, enable the [`debug ports`](#debugging-ports) overlay.

### Cross-boundary routing

When a line crosses between containers that flow in **different directions**, it is
routed by hand rather than by the automatic layout. A `route` statement nested
under the line tunes how — which side it leaves and enters, how far it tunnels
before crossing, and the shape of the crossing:

````
```bpmn
bpmn TB
  region Left LR
    task A
    task B
  region Right TB
    task C
    task D
  A --> C
    route exit:s depth:1 bend:z
```
````

A `route` may also sit under an **entity** (a default for every line in its
subtree) or at the **diagram root** (a default for the whole diagram); when routes
are set at more than one level, the **closest** one wins per setting. A `route` on
a line that crosses no boundary has nothing to tune and is reported with a console
warning.

The full set of keys, their values, and worked examples are in
[docs/routing.md](docs/routing.md).

### Debugging ports

Connection points are laid out zero-size and are normally invisible. Add a
`debug ports` directive at the diagram root (directly under `bpmn`) to draw each
one as a small square, so you can see exactly where a crossing line enters and
leaves each container. Ports you declared yourself draw **green**; the ones the
router adds while tunneling a crossing line draw **red**:

````
```bpmn
bpmn TB
  debug ports
  region Left LR
    task A
  region Right TB
    task C
  A --> C
```
````

The directive is only valid at the root — nested under an entity it is dropped
with a console warning.

## Development

Everything below is for working on `mermaid-bpmn` itself, not for using it.

### Project layout

| Path                         | What it is                                                                                                                                                  |
|------------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `src/index.ts`               | The `ExternalDiagramDefinition` — id (`bpmn`), detector, lazy loader                                                                                        |
| `src/diagram.ts`             | Wires db + parser + renderer + styles together; captures the theme config getter via `injectUtils`                                                          |
| `src/parser.ts`              | Line-oriented parser: indent stack for nesting, keyword dispatch per line, BPMN entity grammar                                                              |
| `src/complexLines.ts`        | Expands complex lines (id-only chains) into one plain line per arrow — pure, unit-tested                                                                    |
| `src/db.ts`                  | In-memory entity tree, connection list, layout direction, and style declarations (classDefs, named styles/classes)                                          |
| `src/styleModel.ts`          | Resolves classes/`style`/inheritance into a concrete fill + outline + icon per entity — pure, unit-tested                                                   |
| `src/icons.ts`               | Icon-pack registry (incl. the always-on `bpmn` pack), lazy loading, and resolving `icon:pack:name` to inline SVG                                            |
| `src/bpmnIcons.ts`           | Generated: the bundled `bpmn` icon pack — MDI-derived glyphs plus hand-drawn gateway/event markers. Regenerate with `npm run gen:icons`                     |
| `scripts/gen-bpmn-icons.mjs` | Build-time generator: extracts the MDI icons from `@iconify-json/mdi` (a devDependency) and merges the hand-drawn gateway/event markers into `bpmnIcons.ts` |
| `src/portTypes.ts`           | Flags invalid port lines (an arrowhead landing on a port) — pure, unit-tested                                                                               |
| `src/theme.ts`               | Bridges Mermaid's resolved theme variables into the renderer's palette (fill/stroke/line)                                                                   |
| `src/renderer.ts`            | Lays out with elkjs, draws the SVG via the DOM; applies the plan from `routePlan.ts`                                                                        |
| `src/routePlan.ts`           | Pure line-routing decisions (flatten vs. port chains, exit side, depth, join/bridge, arrow placement) — unit-tested                                         |
| `src/geometry.ts`            | Pure layout math (region tiling, stadium-cap geometry, edge common-ancestor) — no DOM/ELK, unit-tested                                                      |
| `src/styles.ts`              | Theme-aware CSS injected into the diagram's `<svg>`                                                                                                         |
| `test/`                      | Vitest tests: parser, db, style resolution, geometry, the route planner, icons, plus real-ELK routing checks                                                |
| `examples/`                  | Visual playground you open in a browser                                                                                                                     |

### Working on it

```bash
npm install        # first time: approve esbuild's install script if prompted
npm test           # fast headless tests
npm run test:watch
npm run gen:icons  # regenerate the bundled bpmn icon pack from MDI
```

The visual playground runs the library straight from source:

```bash
npm run dev              # Vite dev server on :5173
```

- **http://localhost:5173/** — the playground (`examples/index.html`)
- **http://localhost:5173/editor.html** — the live editor

The pages import the library straight from `src/` (TypeScript), so editing either
`examples/cases.js` or the library source and refreshing is enough — **no rebuild
needed**. Add cases to `examples/cases.js` to eyeball new features.

```bash
npm run build:examples   # bundle the two pages into site/ (what Pages serves)
npm run preview:examples # serve that build locally to sanity-check it
```

### Build & release

```bash
npm run build      # tsup → dist/ (ESM + .d.ts)
npm run release    # test + build + npm publish
```

`mermaid` is a peer dependency (`^11`); consumers bring their own. The main
runtime dependency is [`elkjs`](https://github.com/kieler/elkjs), which computes
the nested-box layout; [`@iconify/utils`](https://iconify.design/) is a second,
loaded by dynamic import only when a diagram actually uses an [icon](#icons). The
bundled `bpmn` icons are derived from Material Design Icons (Apache-2.0) — see
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) and [licenses/](licenses/);
`mermaid-bpmn` itself is MIT.
