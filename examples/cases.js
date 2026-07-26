// One entry per feature you want to eyeball. Add cases as the diagram grows.
export const cases = [
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
    title: '3 activities, last two in a region tb',
    code: `bpmn
  task A
  region tb
    task B
    task C
  A --> B
  B --> C`,
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
    title: 'Task-type icons (bpmn pack)',
    code: `bpmn
  user task "Approve"
  service task "Charge card"
  send task "Notify"
  script task "Transform"`,
  },
  {
    title: 'Activity types',
    code: `bpmn
  task "Task"
  subprocess "Subprocess"
  call "Call activity"
  event-subprocess "Event subprocess"
  transaction "Transaction"`,
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
    title: 'All gate types',
    code: `bpmn
  gate g1
  inclusive gate g2
  parallel gate g3
  event gate g4`,
  },
  {
    title: 'Gateway fork and join',
    code: `bpmn
  gate fork
  task A
  task B
  gate join
  fork --> A
  fork --> B
  A --> join
  B --> join`,
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
    title: 'Line-end slashes (all forms)',
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
  task A5
  task B5
  A1 /-- B1
  A2 --/ B2
  A3 /--> B3
  A4 <--/ B4
  A5 /--/ B5`,
  },
  {
    title: 'All event types and operations',
    // One region per event operation; within each, the event TYPES that BPMN
    // allows for that operation (invalid combinations are omitted). Boundary
    // events sit loose here rather than on a host activity — not valid BPMN, but
    // it renders the glyphs for the catalogue.
    code: `bpmn tb
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
    timer boundary
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
  {
    title: 'Label with \\n line breaks',
    code: `bpmn
  task a "Charge\\nthe card"
  gate g "Approved\\nand signed?"
  message boundary onMsg "waiting\\nfor reply"
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
  {
    title: 'Empty pool',
    code: `bpmn
  pool "Order handling" TB
  pool "Processing"`,
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
    title: 'Expanded subprocess (start -> task -> end)',
    code: `bpmn
  parallel subprocess "Handle order"
    start
    task Process
    end
    start --> Process
    Process --> end`,
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
  }
];
