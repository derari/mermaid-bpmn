# Line routing

How mermaid-bpmn decides to draw a line between two entities, and why the machinery
(flattening, ports, hand-drawn bridges) exists. This is the design model; the
`route` keyword (see the README) is the user-facing knob that tunes it.

## The tension we are working around

Every container can choose its own flow direction (`tb`, `lr`, …), and we
want each one honored. We lay the diagram out with ELK, which gives us exactly
two ways to treat a container's children — and neither one does everything we
need:

- **SEPARATE** (ELK's default). Each container is laid out on its own, so its
  direction is respected. **But** any edge that crosses a container boundary is
  *dropped* — ELK returns no route for it.
- **INCLUDE_CHILDREN** ("flattening"). A container's whole subtree is laid out in
  a single pass, so boundary-crossing edges inside it *are* routed. **But** that
  single pass imposes **one** direction on the entire subtree, overriding any
  child's own direction.

So the trade is: *preserve directions* (SEPARATE) **or** *route across
boundaries* (flatten, losing the sub-directions). The routing model is about
getting both at once.

Throughout, the **LCA** of a line is the lowest container that holds both of its
endpoints — the container ELK must route the edge in.

## Case 1 — nothing special needed

When both endpoints are direct children of the same container, the edge doesn't
cross any boundary. ELK routes it directly, in that container's own direction.

```bpmn
bpmn lr
  region R lr
    task A
    task B
    A --> B
```

`A` and `B` are siblings in `R`; the line stays inside `R`. No flattening, no
ports.

## Case 2 — why flattening is *sometimes* needed

Now the endpoints sit in *different* sub-containers:

```bpmn
bpmn tb
  region Left tb
    task A
  region Right tb
    task B
  A --> B
```

`A → B` crosses the `Left`/`Right` boundary; its LCA is the root. Under SEPARATE,
ELK **drops** this edge — it would not be drawn at all. To get it routed we must
flatten the LCA (INCLUDE_CHILDREN on the root).

Is that safe here? The root's whole subtree flows **one** direction — `Left` is
`tb`, `Right` is `tb`, the root is `tb`. Flattening imposes `tb` on everything,
which is *already* true, so **flattening changes nothing visible**. We get the
crossing edge routed for free, with no direction clobbered.

> **Flattening is needed** whenever a line crosses a boundary, **and safe only
> when the flattened subtree already flows a single direction.**

## Case 3 — …and why flattening must *sometimes not* happen

Same shape, but the two regions now flow differently:

```bpmn
bpmn tb
  region Left lr
    task A1
    task A2
  region Right tb
    task B1
    task B2
  A1 --> B1
```

`A1 → B1` again crosses at the root. But flattening the root would force `tb` onto
`Left`, and `Left` wants `lr` — flattening would **rotate `Left`'s contents** and
break the diagram the author asked for.

```
flatten the root (WRONG)          keep directions (WANTED)
+----------------------+          +----------------------+
| Left(now tb)  Right  |          | Left (lr)     Right  |
|   A1            B1    |          |  A1 A2         B1     |
|   A2            B2    |          |                B2    |
+----------------------+          +----------------------+
  A1/A2 stacked, not                A1/A2 side by side,
  the lr the author asked for       as declared
```

So here we **must not** flatten. But SEPARATE drops the edge. That's the gap
ports fill.

## Why ports

A **port** is a fixed connection point we pin on a container's boundary, on a
chosen side, *before* layout. ELK then routes the segment from the inner node
**to that port entirely inside the container**, using the container's *own*
direction — no flattening required. On the far side of the boundary we continue
from the port outward.

For Case 3: put an east port on `Left` and a west port on `Right`.

```
+-----------------+        +-----------------+
| Left (lr)       |        | Right (tb)      |
|  A1  A2 o-------------->o  B1              |
|                 |        |  B2             |
+-----------------+        +-----------------+
     ELK routes         ELK routes port->B1
     A1->port inside    inside Right (tb)
     Left (lr)
```

`Left` still lays out `lr`, `Right` still lays out `tb`, and the line crosses
between them. Ports buy us the crossing **without** the flattening tax on
direction.

## Chaining ports, and the one hard constraint

When the source is nested more than one level below the LCA, one port isn't
enough — we place a port on each container on the way out and connect them into a
**chain**:

```
B --> port(Bottom) --> port(Big) --> port(Other) --> T
      (in Bottom)      (in Big)      (at the LCA)     (in Other)
```

Each hop is routed by ELK **inside** the relevant container, so every level keeps
its direction.

**The one rule you cannot break:** each hop must go from a node (or port) to a
port on its **immediate** parent — climb **exactly one level at a time.** An edge
that jumps from a deep node straight to a port on a non-immediate ancestor is
*rejected by ELK* (it throws) whenever that ancestor is flattened. Climbing one
level per hop avoids this entirely.

This is also *why ports and flattening coexist peacefully*: even if `Big` is
flattened, `port(Bottom) → port(Big)` is still a child-to-its-own-parent hop,
which ELK allows. So a flattened container can host a port chain passing through
it — nothing has to be un-flattened.

## `depth` — capping port inflation

Ports aren't free: ELK reserves routing space for each one, which **inflates** the
container it sits on (it grows to leave room). A chain all the way up to the LCA
therefore enlarges every container it passes through.

`depth` caps how many levels get ports, from the innermost outward. Wherever the
port chain **stops short** of a common ancestor, the remaining gap is closed with
a **hand-drawn bridge** (a plain orthogonal segment) instead of more ports.

```
depth:auto   B -o- -o- -o- T     all ELK-routed, ports on every level (widest)
depth:1      B -o-......bridge......T   one port each side, hand-drawn middle
depth:0      B .........bridge..........T   no ports, fully hand-drawn (tightest)
```

So `depth` is the dial between **tight layout with a rougher hand-drawn middle**
(low `depth`) and **fully orthogonal ELK routing that spreads the diagram out**
(high `depth`).

## Everything together

```bpmn
bpmn lr
  region Big tb
    region Top tb
      task A
      task S
    region Bottom tb
      task B
      task S2
    A --> S2
  region Other tb
    task T
  B --> T
    route depth:1
```

- `A → S2` crosses `Top`/`Bottom`, LCA `Big`. `Big`'s subtree is all `tb`
  (uniform) → **flatten `Big`** (Case 2). Routed by ELK, no ports.
- `B → T` crosses to sibling `Other`, LCA the root. The root is *mixed*
  (`Big` is `tb`, the root is `lr`) → **ports** (Case 3). `B` is two levels deep;
  with `depth:1` we place one source port (on `Bottom`) and one target port (on
  `Other`). Their parents differ (`Big` vs the root), so the middle is a
  **hand-drawn bridge**. With `depth:2` (or `auto`) the source chain reaches the
  root too, both outer ports share the root as parent, and ELK connects them —
  no bridge.
- `Big` is flattened **and** carries `B`'s port chain at the same time — allowed,
  because the chain climbs one level per hop.

Expect ELK to **shift boxes** to make the ports routable (e.g. `Bottom` slides
sideways so its port has room). Positions move; **directions never do** — that is
the whole point of preferring ports over flattening in the mixed case.

## The rules

1. **Flatten** (INCLUDE_CHILDREN) every container whose entire subtree already
   flows a single direction. Any line whose LCA is such a container is routed
   **wholly by ELK** — flattening is invisible there and handles the crossing.

2. For a line whose LCA is **not** uniform (mixed directions), route it with a
   **port chain**:
   - From the **source** outward, place a port on each enclosing container, up to
     `depth` levels; do the same from the **target**.
   - Connect consecutive ports with ELK routing, **climbing exactly one level per
     hop** (never a node → non-immediate-ancestor port).
   - If the outermost source port and outermost target port share the **same
     parent**, connect them with ELK routing (an ordinary edge in that parent).
     Otherwise, connect them with a **hand-drawn bridge**.

3. Flattening (rule 1) and port chains (rule 2) **compose** — a flattened
   container may still carry a port chain through it. No container ever has to
   choose between the two, and no precedence rule is needed, *provided* rule 2's
   one-level-per-hop constraint is respected.

### Invariants these rules guarantee

- **Directions are always preserved.** We never flatten a mixed subtree, and a
  port routes inside its container using that container's own direction.
- **Layout may shift, directions may not.** ELK is free to move boxes to make the
  ports routable; that is expected and acceptable.
- **`depth` bounds the port count** (hence the inflation), trading tightness
  against fully-orthogonal routing; the hand-drawn bridge covers whatever the
  ports don't reach.

## Declared ports are not a special case

A user-declared `port` is the *same* primitive as the ports the router invents in
rule 2 — the only difference is that the user pinned it, on a side they chose,
instead of the router picking one. So a line touching a declared port takes the
**same** plain/flatten/manual decision as any other line; it is not routed by a
separate path.

The one twist: a declared port is a **fixed anchor**. It already sits on its
container's boundary, so it never grows a routing-port chain of its own — its side
is pinned at `depth 0`, and the *other* endpoint chains toward it. Concretely, in
`planRoute` a declared-port endpoint contributes:

- its **owner** (the port's container) for all the crossing/nesting math — so a
  two-segment-deep port id like `n1.port0` still counts as sitting at `n1`'s level;
- its **port id** as the ELK anchor and bridge point;
- `fixed: true`, which forces its `depth` to 0.

Everything then falls out of the existing rules. A non-crossing port line is
`plain`. A crossing one whose subtree is uniform still `flatten`s (invisible, as
always). A crossing one through mixed directions is `manual`: the free side chains
per `depth` (default 0 → a hand-drawn bridge straight to the port point, exactly
as a node endpoint would; `depth:auto` → an ELK-routed chain that joins the port
in the LCA). If the declared port's *own* container is nested below the LCA, its
fixed side simply doesn't reach the LCA, so the two ends meet with a bridge — the
same fallback the `depth` dial already produces. No extra machinery, and every
container keeps its direction.

## Status

This model is implemented (see `applyManualRoute` / `planChain` in
`src/renderer.ts` and `src/routePlan.ts`). All three rules are in effect:

- Rule 1 — uniform containers flatten (`INCLUDE_CHILDREN`); flat-LCA lines route
  wholly by ELK.
- Rule 2 — mixed-LCA lines grow port chains on **both** sides up to `depth`,
  joined at the LCA by an ELK edge when both reach it, else by a hand-drawn
  bridge.
- Rule 3 — port chains climb one level per hop and so pass through flattened
  containers unchanged; nothing is clamped or un-flattened, and no boundary-exit
  workaround is used.

The `enter:` keyword sets an explicit, possibly asymmetric entry side on the
target, mirroring `exit` on the source (see `resolveEnterSide`). Its default,
`auto`, keeps the original behaviour: the target enters on the side facing the
source's `exit` (the opposite side).
