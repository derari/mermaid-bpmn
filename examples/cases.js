// One entry per feature you want to eyeball. Add cases as the diagram grows.
//
// Ordered to introduce one concept at a time, roughly following the README:
// activities -> gateways -> events -> labels -> artifacts -> pools/lanes ->
// lines -> colors -> icons -> regions -> ports -> cross-boundary routing.
export const cases = [
  // --- Activities -----------------------------------------------------------
  {
    title: 'Single activity',
    code: `bpmn
  task Approve`,
  },
  {
    title: '3 activities with arrows',
    code: `bpmn
  task A
  task B
  task C
  A --> B
  B --> C`,
  },
  {
    title: 'Activity types',
    code: `bpmn
  task "Task"
  call "Call activity"
  subprocess "Subprocess"
  call subprocess "Call subprocess"
  event subprocess "Event subprocess"
  transaction "Transaction"`,
  },
  {
    title: 'Task-type icons (bpmn pack)',
    code: `bpmn
  user task "Approve"
  service task "Charge card"
  send task "Notify"
  receive task "Wait for reply"
  manual task "Flip the switch"
  script task "Transform"`,
  },
  {
    title: 'Activity markers',
    code: `bpmn
  loop task "Loop"
  sequential task "Sequential MI"
  parallel task "Parallel MI"
  compensation task "Compensation"
  adhoc subprocess "Ad-hoc"
  subprocess "Collapsed"
  loop subprocess "Collapsed + loop"`,
  },
  {
    title: 'Expanded subprocess (start -> task -> end)',
    code: `bpmn
  parallel subprocess "Handle order"
    start
    task Process
    end
    start --> Process
    Process --> end`,
  },
  // --- Gateways -------------------------------------------------------------
  {
    title: 'All gate types',
    code: `bpmn tb
  layout elk
  region "Standard Syntax" LR
    exclusive gate
    inclusive gate
    parallel gate
    complex gate
    event gate
  region "Aliases" LR
    xor
    xor gate
    or
    or gate
    and
    and gate`,
  },
  {
    title: 'Gateway fork and join',
    code: `bpmn
  inclusive gate fork
  task A
  task B
  gate join
  fork --> A
  fork --> B
  A --> join
  B --> join`,
  },
  {
    title: 'Gateway fork and automatic join',
    code: `bpmn
  auto-sequence
  start
  inclusive gate
    --> A
    --> fork2
  parallel gate fork2
    --> B
    --> C
  task A
  task B
  task C
  join
    B -->
    C -->
  join
    A -->
  end`,
  },
  // --- Events ---------------------------------------------------------------
  {
    title: 'All event types and operations',
    // One region per event operation; within each, the event TYPES that BPMN
    // allows for that operation (invalid combinations are omitted). Boundary
    // events sit loose here rather than on a host activity — not valid BPMN, but
    // it renders the glyphs for the catalogue.
    code: `bpmn tb
  layout elk
  region "Start Events" lr
    start "Start"
    message start "Message"
    timer start "Timer"
    conditional start "Conditional"
    signal start "Signal"
    multiple start "Multiple"
    parallel start "Parallel"
  region "Non-interrupting Start Events" lr
    message non-interrupt "Message"
    timer non-interrupt "Timer"
    conditional non-interrupt "Conditional"
    signal non-interrupt "Signal"
    escalation non-interrupt "Escalation"
    multiple non-interrupt "Multiple"
    parallel non-interrupt "Parallel"
  region "Catch Events" lr
    message catch "Message"
    timer catch "Timer"
    conditional catch "Conditional"
    link catch "Link"
    signal catch "Signal"
    multiple catch "Multiple"
    parallel catch "Parallel"
    catch "Custom"
      style icon:lucide:banana
  region "Throw Events" lr
    message throw "Message"
    link throw "Link"
    signal throw "Signal"
    escalation throw "Escalation"
    compensation throw "Compensation"
    multiple throw "Multiple"
  region "Interrupting Boundary Events" lr
    message boundary "Message"
    timer boundary "Timer"
    conditional boundary "Conditional"
    signal boundary "Signal"
    error boundary "Error"
    escalation boundary "Escalation"
    compensation boundary "Compensation"
    cancel boundary "Cancel"
    multiple boundary "Multiple"
    parallel boundary "Parallel"
  region "Non-interrupting Boundary Events" lr
    message boundary continue "Message"
    timer boundary continue "Timer"
    conditional boundary continue "Conditional"
    signal boundary continue "Signal"
    escalation boundary continue "Escalation"
    multiple boundary continue "Multiple"
    parallel boundary continue "Parallel"
  region "End Events" lr
    end e_non "End"
    message end "Message"
    signal end "Signal"
    error end "Error"
    escalation end "Escalation"
    compensation end "Compensation"
    cancel end "Cancel"
    termination "Termination"
    multiple end "Multiple"`,
  },
  {
    title: 'Boundary events on activities',
    code: `bpmn lr
  task Order "Handle order"
    timer boundary timer
    error boundary e "Failure" w
  subprocess Ship "Ship goods"
    message boundary continue msg "Update" n
    task Pack
    task Label
  task Cancel "Cancel order"
  task Fix "Investigate"
  task Notify "Notify customer"
  Order --> Ship
  timer --> Cancel
  e --> Fix
  msg --> Notify`,
  },
  {
    title: 'Boundary event sides (auto vs explicit)',
    code: `bpmn tb
  task A "Auto (90° cw of tb = west)"
    error boundary
  task B "Explicit south"
    timer boundary s
  A --> B`,
  },
  {
    title: 'Boundary event clears markers and container label',
    code: `bpmn
  loop task Retry "Retry payment"
    timer boundary t "30s"
  subprocess Handle "Handle dispute"
    error boundary err "Rejected" n
    task Review
    task Resolve
  task Escalate
  Retry --> Handle
  t --> Escalate
  err --> Escalate`,
  },
  {
    title: 'Boundary event auto faces its handler lane',
    code: `bpmn
  pool P
    lane Handling
      task Fix "Handle error"
    lane Main
      task A "Do work"
        error boundary eA
      task Ok "Continue"
  A --> Ok
  eA --> Fix`,
  },
  // --- Names and labels -----------------------------------------------------
  {
    title: 'Label with \\-Space line breaks',
    code: `bpmn
  task a "Charge\\ the card"
  gate g "Approved\\ and signed?"
  message boundary onMsg "waiting\\ for reply"
  a --> g`,
  },
  {
    title: 'Multi-line | labels',
    code: `bpmn
  subprocess Bob | :::hot
      Multi line heading
      first line sets the indent
        this row is further indented
      back to the base
    task Nested in Bob
  data obj |
      Order
      record
  Bob --> obj
  classDef hot fill:#ffe0b2`,
  },
  // --- Artifacts: data, groups, text annotations ----------------------------
  {
    title: 'Data elements',
    code: `bpmn
  data obj "Order"
  data collection items "Order Items"
  data store records "Records"
  task process "Process"
  obj --> process
  items --> process
  process --> records`,
  },
  {
    title: 'Group (dash-dot box, label defaults to name)',
    code: `bpmn LR
  auto-sequence
  start
  group Review
    task Validate
    task Approve
  task Archive
  end`,
  },
  {
    title: 'Text annotations (comment)',
    code: `bpmn LR
  task Review
  comment w1 "Explicit west bracket" w
  comment e1 "Explicit east bracket" e
  comment near "Auto: bracket faces the task"
  Review --- near
  comment filled "Filled note" :::hi
  classDef hi fill:#fff3c4`,
  },
  // --- Pools and lanes ------------------------------------------------------
  {
    title: 'Empty pool',
    code: `bpmn tb
  pool "Order handling"
  pool "Processing" lr`,
  },
  {
    title: 'Pool with lanes (horizontal)',
    code: `bpmn LR
  pool "Order process"
    lane "Customer"
    lane "Warehouse"
      task Pick
      task Ship
      Pick --> Ship
  pool "Approval"
    lane "Reviewer"
    lane "Manager"
      task Check
      task Approve
      Check --> Approve`,
  },
  {
    title: 'Pool with lanes (vertical)',
    code: `bpmn TB
  pool "Order process"
    lane "Customer"
    lane "Warehouse"
      task Pick
      task Ship
      Pick --> Ship
  pool "Approval"
    lane "Reviewer"
    lane "Manager"
      task Check
      task Approve
      Check --> Approve`,
  },
  {
    title: 'Auto-sequence (inherited on, opt-out lane)',
    code: `bpmn
  auto-sequence
  pool "Order"
    lane "Sales"
      start
      gate
        --> Review
        --> Approve
      user task Review
        --> end
      task Approve
      end
    lane "Ops"
      auto-sequence off
      task Pack
      task Ship`,
  },
  // --- Lines ----------------------------------------------------------------
  {
    title: 'Line labels (quoted, near source)',
    // A quoted label at the end of a line is drawn along it, near the source. On a
    // complex chain the label applies to the first segment only.
    code: `bpmn LR
  start
  exclusive gate check "Approved?"
  task Approve
  task Reject
  gate join
  task Archive
  start --> check "submit"
  check --> Approve "yes"
  check /--> Reject "no"
  Approve --> join
  Reject --> join
  join --> Archive "always"`,
  },
  {
    title: 'Default sequence flow (slash marker)',
    // A leading `/` on the connector draws BPMN's default-sequence-flow slash at
    // the source end — here on the branch the gateway falls through to.
    code: `bpmn LR
  start
  exclusive gate check "Approved?"
  task Approve
  task Reject
  start --> check
  check --> Approve
  check /--> Reject`,
  },
  {
    title: 'Line-end slashes (default branch)',
    // A `/` on either end of a connector draws a diagonal slash there, independent
    // of the arrowhead: `/--`, `--/`, `/-->`, `<--/`, and `/--/` on both ends.
    code: `bpmn LR
  task A1
  task B1
  task A2
  task B2
  task A3
  task B3
  task A4
  task B4
  A1 /-- B1
  A2 --/ B2
  A3 /--> B3
  A4 <--/ B4`,
  },
  {
    title: 'Lines crossing pool',
    code: `bpmn TB
  pool A LR
    lane Bobs Lane
      manual task Bob
        --> Alice
  pool B LR
    lane Alices Lane
      user task Alice`
  },
  {
    title: 'Multiple lines to a pool (own ports)',
    code: `bpmn
  debug ports
  pool P1
  pool
    lane
      task
        --> P1
      task
        --> P1`
  },
  // --- Styling: colors ------------------------------------------------------
  {
    title: 'Color: line stroke set inline',
    code: `bpmn LR
  task Producer
  task Consumer
  Producer --> Consumer
    style stroke:#00897b`,
  },
  {
    title: 'Color: styled complex connector (every segment)',
    // A `style` nested under a chain sets the stroke of every generated segment.
    code: `bpmn LR
  task Producer
  gate Route
  task Consumer
  Producer --> Route --> Consumer
    style stroke:#00897b`,
  },
  {
    title: 'Color: stroke inherited by a node and its inner line',
    // Only `stroke` cascades: a child and any line declared inside the styled
    // container pick up the inherited stroke (`fill` never cascades).
    code: `bpmn
  group Frontend
    style stroke:#ee248a
    direction TB
    task Router
    --> API
  group Backend
    task API`,
  },
  {
    title: 'Color: classDef + class and the ::: shorthand',
    // A class attaches by `:::` on the declaration or by a `class` statement; its
    // stroke cascades to children, its fill does not.
    code: `bpmn TB
  classDef critical fill:#ffcdd2, stroke:#7f0000
  classDef muted fill:#9cbfb1
  group Payments:::critical
    task Ledger
    task Fraud Check
  catch Archive
  class Archive muted`,
  },
  {
    title: 'Color: bare style nested under the node it targets',
    code: `bpmn TB
  group Warehouse
    style fill:#bbdefb
    task Picker
    task Packer`,
  },
  // --- Styling: icons -------------------------------------------------------
  {
    title: 'Icons: line-height icon before the label',
    code: `bpmn
  task web "Web Server"
    style icon:lucide:server
  task db "Database"
    style icon:lucide:database
  web --> db`,
  },
  {
    title: 'Icons: via classDef and :::',
    code: `bpmn TB
  classDef svc icon:lucide:box
  task Gateway:::svc
  task Worker:::svc`,
  },
  {
    title: 'Icons: label-less, childless box draws a big icon',
    // A box with neither a label nor children draws its icon alone at double the
    // inline size.
    code: `bpmn
  task a ""
    style icon:lucide:cloud
  catch b ""
    style icon:lucide:wifi
  a --> b`,
  },
  {
    title: 'Icons: in the label band of a container',
    // A container with a caption and an icon shows the icon in its heading band.
    code: `bpmn
  group Backend
    direction TB
    style icon:lucide:server
    task API
    task Worker
  region "Processing"
    style icon:lucide:triangle-alert
    task Filter
  Backend --> Filter`,
  },
  {
    title: 'Icons: icon-size (s/m/l/xl and a numeric factor)',
    // `icon-size` scales the glyph against the line height: s/m/l are 1/2/3, each
    // leading `x` adds one, and a bare number is taken verbatim.
    code: `bpmn
  task s "Small"
    style icon:lucide:server icon-size:s
  task m "Medium"
    style icon:lucide:server icon-size:m
  task l "Large"
    style icon:lucide:server icon-size:l
  task xl "X-Large"
    style icon:lucide:server icon-size:xl
  task db "Database (icon-size:1.5)"
    style icon:lucide:database icon-size:1.5
  task db2 "Smaller (icon-size:.67)"
    style icon:lucide:database icon-size:.67`,
  },
  // --- Curly syntax ---------------------------------------------------------
  {
    title: 'Curly syntax: braces nest instead of indentation',
    code: `bpmn
    subprocess Order {
  subprocess Pick
      subprocess Pack
  Pick --> Pack
  }
      task Ship
      Order --> Ship`,
  },
  // --- Layout: regions ------------------------------------------------------
  {
    title: 'Region: 3 activities, last two in a region tb',
    code: `bpmn
  layout elk
  task A
  region tb
    task B
    task C
  A --> B
  B --> C`,
  },
  {
   title: 'Region: per-region layout direction',
   code: `bpmn TB
  layout elk
  region LR
    task Alice
    task Bob
  region
    task Carol`,
  },
  {
   title: 'Region: a styled region at root pads around its children',
   code: `bpmn TB
  layout elk
  region
    style fill:#ffcdd2
    task bob`,
  },
  {
   title: 'Region: styled regions tile their parent border to border',
   code: `bpmn TB
  layout elk
  group Service
    region Left LR
      task Alice
      task Bob
    region Right
      task Carol
  style Left fill:#e3f2fd
  style Right fill:#fff3e0`,
  },
  {
   title: 'Region: extends around nodes, with a cross-boundary line',
   code: `bpmn TB
  layout elk
  group Service
    region Left
      task Alice
      task Bob
        --> Carol
    region Right
      task Carol
      task Dave
  style Left fill:#e3f2fd
  style Right fill:#fff3e0`,
  },
  {
   title: 'Region: mixed directions with a cross-region line',
   code: `bpmn tb
  layout elk
  region lr
    style fill:#ffcdd2
    task alice
      --> bob
    task bob
      --> carol
  region tb
    style fill:#bbdefb
    task carol
      --> dave
    task dave`,
  },
  // --- Layout: ports --------------------------------------------------------
  {
    title: 'Port: a child wires to its container edge, the port on to a sibling',
    code: `bpmn
  layout elk
  debug ports
  group Service
    port Out e
    task Worker
    Worker --- Out
  catch Database
  Out --> Database`,
  },
  {
   title: 'Port: named ports on two containers, referenced by absolute lines',
   code: `bpmn
  layout elk
  debug ports
  group Frontend
    port Send e
    task UI
    UI --- Send
  group Backend
    port Recv w
    catch Store
    Recv --> Store
  Send --- Recv`,
  },
  {
   title: 'Port: a chain into a nested port bends along the port sides',
   code: `bpmn
  layout elk
  debug ports
  task a
  group x
    direction tb
    region lr
      subprocess s1
        port p1 w
        port n
          --> s2
      catch s2
    port p w
  a -- p -- p1`,
  },
  {
    title: 'Port: ports on leaf entities (event, task) and curly on a task',
    code: `bpmn
  debug ports
  start
    port p1 s
  task {
    port p2 n
  }
  p1 --> p2`,
  },
  // --- Layout: cross-boundary routing ---------------------------------------
  {
   title: 'Route: baseline mixed-direction cross line (no route keyword)',
   code: `bpmn tb
  layout elk
  debug ports
  region Left lr
    task A
    task B
  region Right tb
    catch C
    catch D
  A --> C
  style Left fill:#e3f2fd
  style Right fill:#fff3e0`,
  },
  {
   title: 'Route: depth:1 — both sides routed via ELK ports (auto exit)',
   code: `bpmn tb
  layout elk
  debug ports
  region Left lr
    task A
    task B
  region Right tb
    catch C
    catch D
  A --> C
    route depth:1
  style Left fill:#e3f2fd
  style Right fill:#fff3e0`,
  },
  {
   title: 'Route: exit:n — explicit exit honored literally (loops against geometry)',
   code: `bpmn tb
  layout elk
  debug ports
  region Left lr
    task A
    task B
  region Right tb
    catch C
    catch D
  A --> C
    route exit:n depth:1
  style Left fill:#e3f2fd
  style Right fill:#fff3e0`,
  },
  {
   title: 'Route: depth:0 bend:z — fully hand-routed, HVH',
   code: `bpmn tb
  layout elk
  debug ports
  region Left lr
    task A
    task B
  region Right tb
    catch C
    catch D
  A --> C
    route depth:0 bend:z
  style Left fill:#e3f2fd
  style Right fill:#fff3e0`,
  },
  {
   title: 'Route: depth:0 bend:n — fully hand-routed, VHV',
   code: `bpmn tb
  layout elk
  debug ports
  region Left lr
    task A
    task B
  region Right tb
    catch C
    catch D
  A --> C
    route depth:0 bend:n
  style Left fill:#e3f2fd
  style Right fill:#fff3e0`,
  },
  {
   title: 'Route: depth:0 bend:l — single-corner turn, HV/VH from the exit side',
   code: `bpmn tb
  layout elk
  debug ports
  region Left lr
    task A
    task B
  region Right tb
    catch C
    catch D
  A --> C
    route exit:e enter:n depth:0 bend:l
  style Left fill:#e3f2fd
  style Right fill:#fff3e0`,
  },
  {
   title: 'Route: bend:auto picks an L when the exit and enter edges meet at 90°',
   code: `bpmn tb
  layout elk
  debug ports
  region Left lr
    task A
    task B
  region Right tb
    catch C
    catch D
  A --> C
    route exit:e enter:n depth:0
  style Left fill:#e3f2fd
  style Right fill:#fff3e0`,
  },
  {
   title: 'Route: depth:2 — two-level port chain out of nested containers',
   code: `bpmn tb
  layout elk
  debug ports
  region Outer lr
    catch P
    region Inner tb
      task A
      task B
  catch C
  A --> C
    route exit:s depth:2
  style Outer fill:#e3f2fd
  style Inner fill:#bbdefb`,
  },
  {
    title: 'Route: auto sides follow the pool order ELK produced, not the declaration order',
    code: `bpmn
  debug ports
  route depth:?
  pool A
  pool B
  pool
    lane
      task C
  B --> A
  C --> A`,
  },
  {
    title: 'Route: entity-level route inherited by every line (exit + enter + depth)',
    code: `bpmn tb
  layout elk
  debug ports
  region Left lr
    route exit:s enter:s depth:1
    task A
    task B
    A --> C
    B --> D
  region Right lr
    catch C
    catch D
  style Left fill:#e3f2fd
  style Right fill:#fff3e0`,
  },
  // --- Errors ---------------------------------------------------------------
  {
    title: 'Error: an unparseable line becomes a red diagnostic node',
    code: `bpmn
  task A
  this is not valid bpmn
  task B`,
  },
  {
    title: 'Error: unresolved line target',
    code: `bpmn
  task A
  A --> Missing
  X --> Y
  lane L
    task B
    B --> Nowhere`,
  },
  {
    title: 'Error: violations with nesting',
    code: `bpmn LR
  subprxocess {
task a
task b
}
  pool P
    task T`,
  },

  // --- Layout: auto (no layout engine) -------------------------------------------
  {
    title: 'Auto Layout: single activity',
    code: `bpmn
  layout auto
  task Approve`,
  },
  {
    title: 'Auto Layout: multiple activities',
    code: `bpmn
  layout auto
  task A
  task B
  task C
  A --> B
  B --> C`,
  },
  {
    title: 'Auto Layout: parallel gateways',
    code: `bpmn
  layout auto
  task Start
  parallel gate fork
  task Branch1
  task Branch2
  parallel gate join
  task End
  Start --> fork
  fork --> Branch1
  fork --> Branch2
  Branch1 --> join
  Branch2 --> join
  join --> End`,
  },
  {
    title: 'Auto Layout: expanded sub-process',
    code: `bpmn
  layout auto
  subprocess Handle "Process"
    task A
    task B
    A --> B
  task C
  Handle --> C`,
  },

  {
    title: 'Auto Layout: long labels wrap into the fixed shape',
    code: `bpmn
  layout auto
  task A "Approve the quarterly budget request"
  task B "Notify"
  task C "supercalifragilisticexpialidocious"
  A --> B
  B --> C`,
  },
  {
    title: 'Auto Layout: boundary event on a task',
    code: `bpmn
  layout auto
  start Begin
  task Wait "Wait for payment"
    timer boundary Late "Timeout"
  task Confirm
  task Cancel
  end Done
  Begin --> Wait
  Wait --> Confirm
  Late --> Cancel
  Confirm --> Done
  Cancel --> Done`,
  },
  {
    title: 'Auto Layout: data objects and a data store',
    code: `bpmn
  layout auto
  start Begin
  task Check "Check order"
  task Ship
  end Done
  data Order
  data store Stock "Stock ledger"
  Begin --> Check
  Check --> Ship
  Ship --> Done
  Order --> Check
  Ship --> Stock`,
  },
  {
    title: 'Auto Layout: comments',
    code: `bpmn
  layout auto
  task Review "Review claim"
  task Pay
  comment Why "Four eyes required"
  comment Loose "Not attached to anything"
  Review --> Pay
  Review --- Why`,
  },
  {
    title: 'Auto Layout: group',
    code: `bpmn
  layout auto
  start Begin
  group Back "Back office"
    task Verify
    task Book
  end Done
  comment Note "Handled off site"
  Begin --> Verify
  Verify --> Book
  Book --> Done
  Back --- Note`,
  },
  {
    title: 'Auto Layout: pool with lanes',
    code: `bpmn
  layout auto
  pool Order "Order process"
    lane Sales
      start Begin "Order received"
      task Quote "Prepare quote"
      Begin --> Quote
    lane Warehouse
      task Pick
      task Ship
      end Done
      Pick --> Ship
      Ship --> Done
  Quote --> Pick`,
  },
  {
    title: 'Auto Layout: two pools',
    code: `bpmn
  layout auto
  pool Buyer
    lane Purchasing
      task Order
      task Receive
      Order --> Receive
  pool Seller
    lane Sales
      task Confirm
      task Deliver
      Confirm --> Deliver
  Order --> Confirm
  Deliver --> Receive`,
  },
  {
    title: 'Auto Layout: empty pool and lane',
    code: `bpmn
  layout auto
  pool External "Partner (black box)"
  pool Internal
    lane Idle
    lane Working
      task Work
        --> External
        External -->`,
  },
];
