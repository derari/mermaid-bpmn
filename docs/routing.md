# Line routing

How mermaid-bpmn decides to draw a line between two entities. The machinery —
direction normalization, black-boxing, interior wrappers, auto-ports, hand-drawn
bridges — all exists to work around a single tension in the layout engine (ELK). This
document gives the decision **algorithm** first, then the **problem** it solves, then
walks the algorithm **step by step** with the reasoning behind each choice.

The engine itself is **notation-agnostic**: it lives in `src/layout/` and speaks only
of node ids, flow directions, and container nesting. Everything BPMN — which family is
a box, how it is sized and drawn, which lines are message flows — lives in
`src/bpmnStyle.ts`, and `src/render.ts` wires the two together. The implementation is
`normalizeDirections` / `analyzeFlatten` / `analyzeInterior` / `planRoute`
(`src/layout/routePlan.ts`) and `addConnections` (`src/layout/elk.ts`).

> **The model: flat by default, black-boxes preserved.** Every container is laid out
> **flat** (`INCLUDE_CHILDREN`) so a line ELK-routes freely through it — EXCEPT a
> **black box** (`SEPARATE_CHILDREN`), which is laid out on its own and keeps its own
> direction. A container is a black box when its direction differs from its parent's
> **and it actually branches** (2+ box children); a single-container-child-chain *shell*
> collapses — the differing direction pushes down until it lands on the tightest
> branching container. Every **pool** is a black box too, for a different reason (see
> [Swimlanes](#swimlanes-pools-and-lanes)). `normalizeDirections` pins this global
> black-box set once (INCLUDE flows from the root down, stopping at each black box; set
> explicitly per container, not by ELK inheritance). A line gets **auto-ports only where
> it crosses a black-box boundary**; everywhere else it is a plain ELK edge. A black
> box's uniform **interior is itself flattened** by a synthetic INCLUDE **wrapper**
> region whenever a line enters one of its container-children — so the line routes
> through the interior freely, and the one hop that crosses the wrapper is a hand-drawn
> **bridge**. Auto-ports are **opt-in**: `depth` defaults to **0**, so a boundary
> crossing is a pure hand-drawn bridge unless the line asks for a budget with
> `route depth:auto` (unlimited) or `route depth:N`. See §4.

---

## The algorithm

### Vocabulary

- **owner** of an endpoint — its node id; for a declared `port` (or a boundary event,
  which is also a border port), the port's *container* id.
- **LCA** — the lowest container holding both endpoints' owners. ELK requires a
  boundary-crossing edge to live here.
- **crossing** — some endpoint's owner is nested below the LCA (its parent ≠ LCA).
- **visible** container — one with **2+ box children**; only then does its direction
  affect layout. A single-child (or leaf) container is *direction-transparent*.
- **black box** — a container ELK lays out on its own (`SEPARATE_CHILDREN`), so it keeps
  its direction and no edge can be routed across it. A container is one when its
  direction differs from its parent's *and* it branches, or when it is a **pool**.
  Everything else is flat (`INCLUDE_CHILDREN`). The set is pinned once by
  `normalizeDirections` plus the pool rule (§1a).
- **flat** — a non-black-box container, `INCLUDE_CHILDREN`; a line ELK-routes through it
  with no port. INCLUDE propagates from the root down and stops at each black box.
- **wrapper** — a synthetic INCLUDE region inserted inside a black box to flatten its
  uniform interior (making the interior containers *intermediate* INCLUDE nodes, whose
  ports stay valid). Crossing a wrapper needs a hand-drawn bridge.
- **reachable** (at the LCA) — an endpoint an ELK edge in the LCA can attach to: a direct
  child of the LCA; a node in a flat region reaching the LCA (with no wrapper between);
  or a port on a **black box** whose ancestors up to the LCA are all INCLUDE (the
  boundary port is *exposed*). A port on the LCA itself counts.
- **auto-port** — a routing port planted where a line crosses a black-box shell, so the
  crossing is an ELK edge. **Opt-in** via `route depth:…` (the default budget is 0).
  Ports go **only** on black-box shells (or, via a wrapper, on an intermediate-INCLUDE
  interior container) — **never** on the root of an INCLUDE pass (it throws) nor
  pointlessly inside a flat region.
- **bridge** — a hand-drawn orthogonal segment (no ELK edge) for a hop ELK cannot do or
  we would rather draw: crossing a wrapper, closing the gap when `depth` runs out, or —
  by default — the boundary crossing itself.

### 1 — the global hierarchy (once, for the whole diagram)

Before any line is routed, `normalizeDirections` fixes the black-box set (§1a), and the
engine sets each container's `hierarchyHandling` **explicitly**:

- The root is INCLUDE. INCLUDE **propagates** to every child, and keeps going through
  non-boundary containers, but **stops at a black box**: that container is
  `SEPARATE_CHILDREN` and its children are SEPARATE too (so a port on them is a real
  boundary port, not a throwing top-of-INCLUDE port).
- A synthetic **wrapper** region (inside a black box, §4) is INCLUDE and **re-opens** the
  flow, flattening that black box's uniform interior.

So the diagram is flat everywhere except inside black boxes, and a black box's interior
is flat too wherever a wrapper covers it.

#### 1a — the black-box set

A container is a candidate when its direction differs from its parent's. It is an
*actual* black box only if it **branches** — has 2+ box children. A
single-container-child *shell* collapses: its (invisible) differing direction pushes down
the chain until it reaches the first branching container, which becomes the boundary; the
shells above it normalize to the parent direction (so they flatten). Leaves count as box
children (multiple of them make the direction visible). See `normalizeDirections`.

On top of that, **every pool** is a black box regardless of direction — see
[Swimlanes](#swimlanes-pools-and-lanes).

### 2 — classify each line

1. A line whose whole path is flat (crosses no black box) → a **plain** ELK edge in the LCA.
2. A line that crosses one or more black-box boundaries → a hand-drawn **bridge** by
   default (`depth:0`). With a budget (`route depth:auto` / `depth:N`) it instead grows
   **auto-ports** at those crossings (§4): a port on a plain shell, or the wrapper cascade
   (port on the wrapper's child + bridge + shell port) for a wrapped one; `depth:N` caps
   how many crossings get ports and the rest is a bridge. An all-default `route` (e.g. a
   diagram-wide `route depth:0`) is a no-op — identical to no `route`.

### 3 — apply the hierarchy

Set `hierarchyHandling` **explicitly on every container** (§1): `INCLUDE_CHILDREN` on the
root and every flat container, `SEPARATE_CHILDREN` on every black box, `INCLUDE_CHILDREN`
on every wrapper region. Not by ELK inheritance — an inherited value would leak a
boundary's direction onto its flattened children (or the root's onto a boundary).

### 4 — route each line

Walk each endpoint's enclosing containers out to the LCA and **skip the flat (INCLUDE)
ones** — ELK spans them in a single edge — porting only the **black-box shells** it
crosses:

- A **plain** black-box shell → one ELK hop to a port on the shell.
- A **wrapped** black box → a port on the wrapper's child (an *intermediate* INCLUDE node
  the endpoint reaches in one ELK edge, spanning the flattened interior) + a hand-drawn
  **bridge** over the wrapper + a port on the shell. A declared port deep inside a black
  box cascades out the same way. A line whose endpoint sits inside a wrapper and whose
  target is a port on that same black box's *own* shell also bridges (ELK cannot route
  across a wrapper).
- The two sides meet with an **ELK join edge** in the LCA when both are reachable there
  (each side crossed all its black boxes within budget and no wrapper lies between it and
  the LCA); otherwise a **hand-drawn bridge** closes the gap.
- `depth` is the auto-port budget, and it **defaults to 0** — a crossing is a pure
  hand-drawn bridge unless the line opts in with `route depth:auto` (unlimited) or
  `depth:N` (at most N crossings get ports; the remainder bridges). Depth is only ever
  spent at black-box crossings — a line through flat regions spends none, so an
  all-default `route` is a no-op. Why 0 by default: see *Why auto-ports are opt-in* below.

---

## The problem: what ELK gives us, and what it won't

ELK lays out each compound node and gives us **one knob per container**:
`hierarchyHandling` = `SEPARATE_CHILDREN` (the default) or `INCLUDE_CHILDREN`. From
that knob and how ELK routes hierarchical edges, a handful of hard facts constrain
everything. They were each confirmed empirically against `elkjs`.

**L1 — the core dilemma: SEPARATE preserves direction but drops crossing edges;
INCLUDE routes crossings but clobbers direction.**
Under SEPARATE, each container is laid out on its own, honoring its `direction` — but
any edge that crosses a container boundary is silently *dropped* (no route). Under
INCLUDE, a container's whole subtree is laid out in one pass, so crossing edges *do*
route — but that single pass imposes one direction, rotating any child that wanted a
different one. So the trade is: **preserve directions XOR route crossings**, and the
whole model is about getting both at once.

**L2 — a port on the *topmost* INCLUDE node throws.**
A port on the container that is the **root of an INCLUDE pass** (the topmost INCLUDE node
— nothing INCLUDE above it) is rejected outright (`UnsupportedGraphException`). To be
routable a port must sit on an **intermediate** INCLUDE node — one with an INCLUDE
ancestor above it. This is exactly why flattening a black box's interior needs a *wrapper*
(L4): the wrapper is the pass root, demoting the real interior containers to intermediate.

**L3 — a boundary port is exposed outward, but a deep interior endpoint behind a
SEPARATE box is not.**
A port on a container's boundary can be reached from *outside* the container whatever
its hierarchy role — it is on the edge. But if the container is SEPARATE (opaque), a
deep node *inside* it cannot reach a port on its own boundary: the edge silently drops
(same root cause as L2, one level up). This asymmetry is the whole basis of the chain:
you cannot pull a deep node out in one edge, but you *can* pull it out one SEPARATE
boundary at a time (each hop is a node → port on its *immediate* parent, always legal).

**L4 — one `hierarchyHandling` value per node.**
A container is INCLUDE or SEPARATE, never both. A black-box shell (SEPARATE, to keep its
direction) therefore cannot *also* be INCLUDE to flatten its own interior. To flatten a
black box's interior we insert a **second node** — a synthetic INCLUDE **wrapper region**
as the shell's child: the shell stays SEPARATE, the wrapper takes the INCLUDE, and the
interior containers become *intermediate* INCLUDE nodes (their ports stay valid, L2).

**L5 — flattening is invisible only where it is direction-uniform.**
Imposing direction `D` on a flattened region rotates only *visible* containers (2+
children) whose direction ≠ `D`. A single-child container has no visible direction, so
flattening it any which way is a no-op. This is the lever the whole design pulls on:
"differs" always means *visibly* differs.

**L6 — an INCLUDE node's size and placement belong to its parent's pass.**
Once a container is INCLUDE, its own `elk.nodeSize.minimum` and the parent's node-placement
strategy no longer decide its box — the enclosing pass does. That is fine for an ordinary
container, and fatal for a pool, whose length and alignment we set ourselves (L6 is why
pools are black boxes; see below).

---

## Swimlanes: pools and lanes

Pools and lanes are the one place BPMN pushes back on the generic model, in two ways.

**A pool stacks its lanes ACROSS the flow.** A horizontal (LR) pool lays its lanes out
top-to-bottom, so its ELK layout direction is the flow's perpendicular axis, sign
preserved (`TOGGLE_AXIS`: TB↔LR, BT↔RL). The diagram root does the same when it holds
pools, so the pools themselves stack across the diagram flow. Both pin that direction as
their own rather than inheriting it, which is what makes a **branching lane** a genuine
black box: the lane runs *along* the flow while its pool runs across it, so their
directions always differ.

**A pool is ALWAYS a black box**, whatever its direction works out to. Its toggled axis
usually matches the root's, so the direction rule alone would flatten it — but we own a
pool's geometry and ELK only honours that for a node it lays out on its own (L6):

- `equalisePoolLengths` reads the laid-out pools, then pins every pool that shares a flow
  direction to the longest one's length via `elk.nodeSize.minimum`, so a stack of pools
  lines up flush instead of ragged;
- the root uses `SIMPLE` node placement so a cross-pool message flow can't tempt ELK into
  sliding a pool sideways to shorten the edge.

Both are ignored the moment a pool's size comes from its parent's INCLUDE pass. So a pool
stays opaque, and a line crossing into one is chained or bridged like any other black-box
crossing. For the same reason a pool is **never wrapped**: its children *are* its
swimlanes, and it fits them to its own box at draw time, so an interposed wrapper region
would hide the lanes from that pass.

---

## The algorithm, step by step

### The black-box set — which containers ELK lays out alone (`normalizeDirections`)

A container is a candidate when its direction differs from its parent's (L1: a differing
direction must be protected, or flattening rotates it). It becomes an *actual* black box
only if it is **visible** — 2+ box children (L5: a single child, or a chain of them, has
no visible direction). A single-container-child **shell** is invisible, so its differing
direction is pushed *down* the chain: the shell normalizes to its parent's direction (it
will flatten), and the direction lands on the first branching container below it, which
becomes the black box. Leaves count as box children — two of them make the arrangement
visible, so they keep the direction alive. Every pool joins the set unconditionally.

This is computed once, globally, before any line is routed.

### The global hierarchy — flat by default (`addConnections`)

INCLUDE (flat) propagates from the root down through non-boundary containers and **stops
at each black box**: a black box is `SEPARATE_CHILDREN` and its children stay SEPARATE too
(L3: a real boundary they can host a port on — not a top-of-INCLUDE port that throws, L2).
This is set **explicitly per container**, never by ELK inheritance, which would leak a
boundary's direction onto its flattened children or the root's onto a boundary.

So the diagram is flat everywhere except inside black boxes — a line ELK-routes freely
through the flat regions and needs a port only where it crosses a black box.

### Interior wrappers — flattening a black box inside (`analyzeInterior`, `toElkNode`)

A black box's interior is SEPARATE all the way down by default, so a line through it would
port every level. To flatten a uniform interior we insert a synthetic INCLUDE **wrapper
region** as the shell's sole child (L4: the shell cannot be both SEPARATE and INCLUDE, so a
second node takes the INCLUDE). Its effect (all probed against `elkjs`):

- The interior containers become *intermediate* INCLUDE nodes — an INCLUDE ancestor (the
  wrapper) sits above them — so a port on one is valid (L2: a port on the *topmost* INCLUDE
  node throws; on an intermediate one it routes) and a deep node reaches it in **one** ELK
  edge spanning all the uniform levels.
- Crossing the wrapper itself cannot be ELK-routed (L3) — that one hop is a hand-drawn
  **bridge**.

A black box is wrapped iff a line **enters one of its container-children** — an exiting
line from deep inside, or an internal line whose LCA is the black box crossing between its
sub-containers. A line that only touches a leaf child needs no interior flatten. A
differing sub-container inside the wrapper stays SEPARATE (a nested black box) and recurses.
Pools are excluded (see [Swimlanes](#swimlanes-pools-and-lanes)).

### Routing a line (`planRoute` / `planSide`)

1. **Non-crossing / all-flat path** → a plain ELK edge in the LCA (no ports).
2. **Crossing black boxes** → walk each endpoint's enclosing containers, skip the flat
   (INCLUDE) ones, and cross each black box within the `depth` budget — which is
   **0 unless the line asked for one**, so by default this plants nothing and step 3
   bridges. With a budget:
   - a plain shell → one ELK hop to a port on it;
   - a wrapped shell → a port on the wrapper's child (endpoint→port is one ELK edge over
     the flattened interior) + a **bridge** over the wrapper + a port on the shell.

   A declared port deep inside a black box cascades out the same way.
3. **Join** the two sides at the LCA: an ELK edge when both are reachable there (each
   crossed all its black boxes within budget, and no wrapper lies between it and the LCA),
   else a **bridge**. A line into a port on its *own* wrapped black box's shell also
   bridges (ELK cannot route from inside a wrapper to the shell it wraps).
4. **`route depth:auto`** grants an unlimited budget; **`depth:N`** caps it at N crossings
   and bridges the remainder; **`depth:0`** (the default) bridges the boundary outright.

Only a bridge is non-ELK, and it appears at a wrapper crossing, wherever `depth` runs out,
or — by default — at the boundary crossing itself. `exit`/`enter`/`bend` shape the
hand-drawn parts; `normalizeDirections` plus the per-container hierarchy guarantee every
auto-port sits on a real black-box boundary.

### Where the line's end decorations go

A BPMN line may carry decorations that belong to one *geometric endpoint* each: a message
flow's open **origin circle**, and a **slash** tick from a leading/trailing `/`. When the
route is a single edge they land on that edge directly. When it is a chain, exactly one
piece may draw each, and that piece is the side's **touch element** — its first segment,
or its first bridge when the cascade produced only one. A touch element runs
endpoint → port, so the endpoint is its *start* point; hence a decoration there is always
a `start`, including the arrowhead. When a side grew no chain at all its endpoint sits on
the join instead (source at the join's start, target at its end). See `applyManualRoute`.

### Why auto-ports are opt-in (`depth` defaults to 0)

An auto-port is a *free* ELK port: we fix its side, ELK picks its position. Two ELK
behaviours we probed and could not steer make that a poor default:

- **Port placement.** ELK positions a free port to suit the edge *it* can see, which is
  often far from the thing the port connects to (measured: a port parked ~63px below its
  own connection, giving a down-then-back-up detour). On a *flattened* interior node the
  position is ELK's alone — neither `elk.portConstraints: FIXED_POS` nor
  `elk.portAlignment.default` moves a port that has an attached edge.
- **Join routing.** The ELK join between two ports can wander far off the direct path
  (measured: a ~210px vertical excursion for two ports sitting on the same row).

A hand-drawn bridge has neither problem: we choose both endpoints and the shape
(`exit`/`enter`/`bend`), so it comes out short and predictable. For simple diagrams that is
simply better, so it is the default. Auto-ports remain available via `depth` for the cases
where threading the real boundary matters more than the drawn shape — and the renderer
still aligns a wrapper-bridge shell port onto its counterpart to keep those crossings
straight (`alignBridgePorts`).

## A worked example

```bpmn
bpmn
  route depth:auto
  subprocess a
    port p1 e
    subprocess b
      task c
        --- p1
      subprocess w
        direction tb
        subprocess x
          task
          port p2 e
          subprocess y
            task z
              --- p2
        port p3 e
  task sink
    p1 ---
    p2 ---
    p3 ---
```

The diagram-wide `route depth:auto` is what asks for auto-ports; without it (the default
`depth:0`) the one boundary crossing below is simply a hand-drawn bridge instead — see the
note at the end.

Root is `lr`; `w` and `x` are `tb`. **Normalization**: `a`/`b`/`c` are `lr` (same as the
root) → flat. `w` is `tb` and branches (its subtree holds the visible `tb` grid) → the one
**black box**. `x` is `tb` like `w` → not a boundary → flat. A line enters `w`'s
container-child `x` (both `z---p2` and `p2---sink`), so `w`'s interior is **wrapped** (`x`,
`y` flattened; `x` becomes an intermediate INCLUDE node). Walking the lines:

- `c --- p1`: `c`/`b` are flat, so `c` is reachable at the root and `p1` is a port on `a` →
  a **plain** ELK edge, no ports.
- `p1 --- sink`: both direct children of the root → **plain**.
- `z --- p2`: `p2` is a port on `x` (intermediate INCLUDE inside the wrapper); `z` reaches
  it in **one ELK edge** spanning the flattened `y` — no ports, no bridge.
- `p2 --- sink`: `p2` on `x` exits the black box `w`. It **cascades**: a hand-drawn
  **bridge** from `p2` over the wrapper to a routing port on `w`'s shell, then `w`'s port
  is exposed through the flattened `b`/`a` and ELK-routes to `sink`.
- `p3 --- sink`: `p3` is on `w`'s own shell, exposed at the root → a **plain** ELK edge.

Result: **6 edges** — five plain/ELK segments plus the single `p2 → sink` **bridge** over
the wrapper — one routing port (on `w`), the three declared ports, and every container
keeps its direction. `w` is outlined orange under `debug ports`, its wrapper tinted magenta.

Drop the `route depth:auto` and only that last cascade changes: with no budget, `p2` gets
no port on `w` and instead bridges straight out to `sink` — **5 edges**, **zero** routing
ports, same one wrapper and one bridge. Normalization, the black-box set and the wrapper are
all independent of `depth`; the budget only decides whether the crossing is threaded with
ports or drawn.

---

## Status

The whole routing engine is notation-agnostic and lives in `src/layout/`.
`normalizeDirections` (`layout/routePlan.ts`) pins the global black-box set — a direction
change makes a container a candidate, and the single-container-child collapse decides
whether it actually branches into one; `render.ts` then adds every pool.
`analyzeInterior` decides which black boxes get an interior wrapper (a line enters a
container-child of it). `addConnections` (`layout/elk.ts`) sets hierarchy **explicitly per
container** — INCLUDE propagated from the root, stopping at each black box, re-opened by
wrapper regions — and emits edges via `applyManualRoute`, driven by a small `RouteAdapter`.
`src/render.ts` builds the adapter and the resolved `RouteLine`s (including every
BPMN-specific line decision: pool ports, the message-flow and data-association looks,
slashes, stroke), runs the two-pass build (insert wrapper regions, translate roles
per-entity across the id shift), then orchestrates ELK and drawing; all BPMN-specific
sizing, drawing, and endpoint resolution is in `bpmnStyle.ts`.
`planRoute`/`planSide` route each line: walk the enclosing containers, SKIP the flat
(INCLUDE) ones, and cross each black box — a port on the shell, or (wrapped) a port on the
wrapper's child + a `ChainBridge` over the wrapper + a port on the shell; a declared port
deep inside a black box cascades out the same way. That whole cascade is gated on the
`depth` budget, which **defaults to 0** — so a crossing is a hand-drawn bridge unless the
line opts in with `route depth:auto`/`depth:N` (see *Why auto-ports are opt-in*).
`alignBridgePorts` (`render.ts`) then slides a wrapper-bridge shell port onto its
counterpart's axis and re-lays out, keeping that crossing straight.

Under `debug ports` every black box is outlined orange, each wrapper region is filled
translucent magenta, and every hand-drawn bridge is tinted blue.
