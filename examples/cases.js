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
    title: 'All event types and operations',
    code: `bpmn
  start
  end
  catch mid
  non-interrupt niStart
  message start msgS
  message throw msgT
  timer catch timC
  timer throw timT
  conditional start conS
  conditional throw conT
  link catch lnkC
  link throw lnkT
  error boundary errB
  error end errE
  signal catch sigC
  signal throw sigT
  escalation non-interrupt escN
  escalation throw escT
  compensation catch cmpC
  compensation throw cmpT
  cancel boundary continue cnlB
  cancel end cnlE
  multiple catch mulC
  multiple throw mulT
  parallel start parS
  parallel throw parT
  termination`,
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
