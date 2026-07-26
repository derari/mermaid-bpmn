import { type ChainNode, type ComplexLineSpec, expandComplexLines } from './complexLines.js';
import {
  ACTIVITY_CONTAINER_TYPES,
  type ActivityMarker,
  type ActivityType,
  BOUNDARY_OPERATIONS,
  type DataType,
  type Direction,
  type Entity,
  type EntityType,
  type EventOperation,
  type EventType,
  type GateType,
  type LineType,
  type RouteSpec,
  type Side,
  type SlashEnd,
  STYLE_PROP_KEYS,
  type StyleProps,
  type TaskType,
  db,
} from './db.js';

// Line-oriented parser. We split on newlines and dispatch each line by its
// leading keyword. Indentation is significant: it defines the entity tree, so a
// stack of (indent, entity) frames tracks the current nesting context.
//
// A hand-written line scanner is a deliberate choice over a parser generator:
// indentation-sensitive grammars are awkward in jison/Langium (they need
// synthetic INDENT/DEDENT tokens), whereas an indent stack models it directly.

const HEADER_RE = /^bpmn(?:\s+(\S+))?$/;
const DIRECTION_RE = /^direction\s+(\S+)$/;
// `auto-sequence <on|off>` — toggles auto-sequencing for the container it is
// nested under (the diagram root at the top level). A bare `auto-sequence` turns
// it on. The value is inherited by descendants; the root default is off.
const AUTO_SEQUENCE_RE = /^auto-sequence(?:\s+(on|off))?$/i;
// `debug ports` — a root-only directive that makes the renderer draw the
// otherwise-invisible routing ports as small red squares.
const DEBUG_PORTS_RE = /^debug\s+ports$/;
// `route <props>` — layout hints nested under a line (see parseRoute). Like a
// bare `style`, it must actually parse to be treated as a route statement, so a
// line whose first endpoint is literally named "route" still reads as a line.
const ROUTE_RE = /^route\s+(.+)$/;

// Color styling. `classDef <name> <props>` defines a reusable style bag;
// `class <names> <class>` attaches a class to comma-separated entity names (the
// class name is the final token); `style …` either targets entities by name
// (`style <name> <props>`) or, with no name, styles the entity or line it is
// nested under (`style <props>`). Props are `key:value` pairs separated by
// whitespace, commas, or semicolons (see splitStyleProps / parseProps).
const CLASSDEF_RE = /^classDef\s+(\S+)\s+(.+)$/;
const CLASS_RE = /^class\s+(.+)\s+(\S+)$/;
const STYLE_RE = /^style\s+(.+)$/;
// A single style token: one of the known DSL prop keys, then its value. The value
// may contain spaces and commas (e.g. `rgb(1, 2, 3)`); splitStyleProps keeps them
// together, so this matches everything after the colon. The key match is
// case-insensitive; parseProps lower-cases it before mapping to a field.
const PROP_RE = new RegExp(`^(${[...STYLE_PROP_KEYS.keys()].join('|')}):(.+)$`, 'i');

// Separator between style props: whitespace, comma, or semicolon — but only
// where the next non-separator run starts a fresh `key:` pair (or the string
// ends). The lookahead lets a separator that sits inside a value (a space or
// comma in `rgb(1, 2, 3)` or `linear-gradient(to right, red, blue)`) stay part
// of that value rather than splitting it. `[\w-]+` so a hyphenated key like
// `icon-size:` is recognised as the start of a fresh pair.
const STYLE_SPLIT_RE = /(?:\s+|\s*[,;]\s*)(?=$|[\w-]+\s*:)/;
// Breaks a props string into its `key:value` segments, dropping the empty
// pieces a leading/trailing separator would leave behind.
function splitStyleProps(props: string): string[] {
  return props.trim().split(STYLE_SPLIT_RE).filter(Boolean);
}
// Classes appended to an entity declaration: `task Name:::a b`.
const INLINE_CLASS_SEP = /\s*:::\s*/;

// A quoted label on an entity declaration: `task a "Approve"`. Double quotes fence
// the drawn caption, so the bareword(s) around it stay the reference name (and any
// trailing direction token for a pool/lane/region). The label runs until the next
// unescaped quote; `\"` and `\\` escape a literal quote/backslash inside it.
const LABEL_RE = /"((?:[^"\\]|\\.)*)"/;

// A literal `\n` in a label forces a line break, and the whitespace flanking it is
// gobbled so `"a  \n  b"` reads as `a`\n`b` with no stray leading/trailing spaces.
// `\s` spans real newlines too, so the same rule tidies a `\n` written amid the
// lines of a multi-line (`|`) label. Applied to every label, quoted or multi-line.
const NEWLINE_ESCAPE_RE = /\s*\\[n\s]\s*/g;
function applyNewlineEscapes(text: string): string {
  return text.replace(NEWLINE_ESCAPE_RE, '\n');
}

// Unescapes a quoted label's contents in one left-to-right pass: `\"`/`\\` become a
// literal quote/backslash, and a `\n` (whitespace-gobbled) becomes a line break.
// Doing it in a single scan keeps `\\n` (an escaped backslash then `n`) a literal
// `\n` rather than a newline.
const QUOTED_LABEL_RE = /\s*\\[n\s]\s*|\\(["\\])/g;
function unescapeQuotedLabel(text: string): string {
  return text.replace(QUOTED_LABEL_RE, (_m, escaped: string | undefined) =>
    escaped === undefined ? '\n' : escaped,
  );
}

// Splits an entity's argument string into its optional quoted label and the rest
// (the keyword/type spec, reference name, and any trailing direction token), with
// the label removed. Returns `label: undefined` when no quoted label is present,
// so the caller can tell "no label given" (default caption) from an explicit empty
// `""` (no caption).
function extractLabel(rest: string): { label?: string; rest: string } {
  const m = LABEL_RE.exec(rest);
  if (!m) return { rest };
  const label = unescapeQuotedLabel(m[1]);
  const remainder = (rest.slice(0, m.index) + ' ' + rest.slice(m.index + m[0].length))
    .replace(/\s+/g, ' ')
    .trim();
  return { label, rest: remainder };
}

// Lines connect two entities by name. A connector is a run of one or more
// dashes carrying an optional decoration on each end. A leading `<` points the
// arrow at the first entity (`<--`), a trailing `>` at the second (`-->`),
// neither is plain (`---`). Independently, a slash mark on either end draws a
// slash there (`/--`, `--/`, `/-->`, `<--/`). The slash mark may be spelled `/`,
// `|`, or `\` interchangeably — all three parse to the same slash decoration. The
// dash run may be any length (`-`, `-->`, `<--------`). `<` only ever leads and
// `>` only ever trails, so broken arrows like `-<` or `>-` (and the combined
// `<-->`) don't match; a slash mark may lead and/or trail but never shares an end
// with an arrowhead (so `</` or `>/` on one end don't arise). Whitespace must
// flank the connector so it never eats a hyphen from an entity name.
//
// The three alternatives are `<`-led (optional trailing slash mark), slash-led
// (optional trailing `>` or slash mark), and plain-led (optional trailing `>` or
// slash mark) — every valid combination except a `<`…`>` double arrow. In the raw
// template `\\` is a literal backslash and `|` is literal inside the class.
const SLASH_MARK = String.raw`[/\\|]`;
const ARROW = String.raw`(<-+${SLASH_MARK}?|${SLASH_MARK}-+[>/\\|]?|-+[>/\\|]?)`;

// Collapses a matched connector of any length to its canonical LineType. The
// slash ends are read separately (see slashEnds), so only the arrowheads matter:
// a `<` prefix or `>` suffix, else undirected.
function arrowType(arrow: string): LineType {
  if (arrow.startsWith('<')) return '<--';
  if (arrow.endsWith('>')) return '-->';
  return '---';
}

// Reads the slash decoration of a matched connector: a leading slash mark (`/`,
// `|`, or `\`) marks the source end, a trailing one the target end. Returns
// undefined when neither is present.
function isSlashMark(c: string): boolean {
  return c === '/' || c === '\\' || c === '|';
}
function slashEnds(arrow: string): SlashEnd | undefined {
  const start = isSlashMark(arrow[0]);
  const end = isSlashMark(arrow[arrow.length - 1]);
  if (start && end) return 'both';
  if (start) return 'start';
  if (end) return 'end';
  return undefined;
}

// Either endpoint may be omitted, and the enclosing entity fills the empty slot
// — a LEADING line drops the first entity (`--> B`, source = enclosing), a
// TRAILING line drops the second (`A -->`, target = enclosing). An ABSOLUTE line
// names both and may sit anywhere, regardless of nesting. Whitespace is REQUIRED
// between an arrow and an adjacent entity (`\s+`), so a hyphen inside a name
// (`foo-bar`) is never mistaken for a connector.
const LEAD_LINE_RE = new RegExp(String.raw`^${ARROW}\s+(\S.*)$`);
const TRAIL_LINE_RE = new RegExp(String.raw`^(\S.*?)\s+${ARROW}\s*$`);
const ABS_LINE_RE = new RegExp(String.raw`^(\S.*?)\s+${ARROW}\s+(\S.*)$`);

// A complex line is a chain of any length — `name arrow name arrow name …` —
// linking named entities. It is tokenised by scanChain rather than a fixed regex,
// since the number of segments is unbounded; a chain with two or more arrows is
// treated as complex, while a single-arrow line falls through to the plain-line
// patterns below.
//
// A scanned node is a name or empty (an omitted endpoint of a relative line, only
// ever first or last). Whitespace between an arrow and a name is required (as for
// plain lines, so a hyphen inside a name is never eaten as a connector).
type ScanNode = { kind: 'empty' } | { kind: 'name'; name: string };

const ARROW_AT_RE = new RegExp(String.raw`^${ARROW}`);

// Tokenises a line into alternating nodes and arrows, or returns null when it is
// not a well-formed chain (so the caller falls through to plain-line parsing).
function scanChain(
  s: string,
): { nodes: ScanNode[]; arrows: LineType[]; slashes: (SlashEnd | undefined)[] } | null {
  const N = s.length;
  const isWs = (c: string): boolean => c === ' ' || c === '\t';
  const isArrowChar = (c: string): boolean =>
    c === '<' || c === '-' || c === '>' || isSlashMark(c);
  const arrowAt = (i: number): { type: LineType; slash?: SlashEnd; end: number } | null => {
    const m = ARROW_AT_RE.exec(s.slice(i));
    return m ? { type: arrowType(m[1]), slash: slashEnds(m[1]), end: i + m[1].length } : null;
  };
  // A valid right boundary for an arrow: end of string or whitespace — never a
  // glued name character. `<` alone is not an arrow, so `A <--> B` is rejected.
  const arrowBoundary = (end: number): boolean => end >= N || isWs(s[end]);

  // Reads one node from `i` (skipping leading whitespace) and reports where the
  // next arrow begins (or N). An arrow encountered immediately is an omitted
  // (empty) node and is left unconsumed for the caller.
  const readNode = (i: number): { node: ScanNode; next: number } => {
    let j = i;
    while (j < N && isWs(s[j])) j++;
    if (j >= N) return { node: { kind: 'empty' }, next: N };
    if (isArrowChar(s[j]) && arrowAt(j)) return { node: { kind: 'empty' }, next: j };
    // A name, running to the next whitespace-flanked arrow (or end).
    for (let k = j; k < N; k++) {
      if (!isWs(s[k])) continue;
      let p = k;
      while (p < N && isWs(s[p])) p++;
      const ar = arrowAt(p);
      if (ar && arrowBoundary(ar.end)) return { node: { kind: 'name', name: s.slice(j, k) }, next: p };
    }
    return { node: { kind: 'name', name: s.slice(j).trimEnd() }, next: N };
  };

  const nodes: ScanNode[] = [];
  const arrows: LineType[] = [];
  const slashes: (SlashEnd | undefined)[] = [];
  let cur = readNode(0);
  nodes.push(cur.node);
  let i = cur.next;
  while (i < N) {
    while (i < N && isWs(s[i])) i++;
    if (i >= N) break;
    const ar = arrowAt(i);
    if (!ar || !arrowBoundary(ar.end)) return null;
    arrows.push(ar.type);
    slashes.push(ar.slash);
    cur = readNode(ar.end);
    nodes.push(cur.node);
    i = cur.next;
  }
  return { nodes, arrows, slashes };
}

// Parses an `icon-size` value into a numeric factor of the line height (1 = one
// line height). `auto`/`?` mean "size from context" and are stored as 0 (which,
// like undefined, reads as auto). `s`/`m`/`l` are 1/2/3, and each leading `x` on
// `l` adds one (`xl`=4, `xxl`=5, …); a bare number (`1.5`, `.7`) is taken verbatim.
// Anything else is dropped with a warning (returns undefined), like a bad route key.
function parseIconSize(value: string): number | undefined {
  const v = value.toLowerCase();
  if (v === 'auto' || v === '?') return 0;
  if (v === 's') return 1;
  if (v === 'm') return 2;
  const xl = /^(x*)l$/.exec(v);
  if (xl) return 3 + xl[1].length;
  if (/^\d*\.?\d+$/.test(v)) return parseFloat(v);
  console.warn(
    `bpmn: ignoring icon-size:${value} (expected auto/?, s/m/l with leading x's, or a number)`,
  );
  return undefined;
}

// Reads `key:value` tokens into a StyleProps, mapping each DSL key to its field.
// Color/icon values pass through verbatim; `icon-size` is parsed to a number.
// Tokens that aren't a known `key:value` are skipped; returns null when no valid
// prop was found, so callers can tell a real props run from e.g. a stray word.
function parseProps(tokens: string[]): StyleProps | null {
  const style: StyleProps = {};
  let found = false;
  for (const token of tokens) {
    const m = PROP_RE.exec(token);
    if (!m) continue;
    const field = STYLE_PROP_KEYS.get(m[1].toLowerCase());
    if (!field) continue; // unreachable: PROP_RE is built from the same keys
    const value = m[2].trim();
    if (field === 'iconSize') {
      const factor = parseIconSize(value);
      if (factor === undefined) continue; // invalid value already warned
      style.iconSize = factor;
    } else {
      style[field] = value;
    }
    found = true;
  }
  return found ? style : null;
}

// Splits `style …`'s remainder into a (possibly multi-word) name and a trailing
// run of style props: props are peeled off the end while they parse, and the
// rest is the name. An empty name means the bare, self-targeting form.
function splitNameAndProps(rest: string): { name: string; style: StyleProps } | null {
  const segments = splitStyleProps(rest);
  const propSegments: string[] = [];
  while (segments.length > 0 && PROP_RE.test(segments[segments.length - 1])) {
    propSegments.unshift(segments.pop() as string);
  }
  const style = parseProps(propSegments);
  if (!style) return null; // no trailing props -> not a style statement
  return { name: segments.join(' '), style };
}

// Anything a bare `style` can attach to carries an optional `style` bag; this
// merges new props in, later values winning per property.
interface Styleable {
  style?: StyleProps;
}
function applyStyle(target: Styleable, props: StyleProps): void {
  target.style = { ...(target.style ?? {}), ...props };
}

// Anything a `route` statement can attach to (a line or complex-line spec)
// carries an optional routing bag; this merges new keys in, later values winning.
interface Routable {
  routing?: RouteSpec;
}
function applyRoute(target: Routable, spec: RouteSpec): void {
  target.routing = { ...(target.routing ?? {}), ...spec };
}

// Route `exit`/`enter` sides accept the single-letter compass form and the full word.
const ROUTE_SIDES: ReadonlyMap<string, Side> = new Map<string, Side>([
  ['n', 'n'],
  ['north', 'n'],
  ['e', 'e'],
  ['east', 'e'],
  ['s', 's'],
  ['south', 's'],
  ['w', 'w'],
  ['west', 'w'],
]);

// Parses a `route`'s props (`exit:s enter:n depth:2 bend:z`) into a validated RouteSpec,
// splitting on the same separators as style props. Each key has its own small
// vocabulary; an unknown key, or a value outside its vocabulary, is dropped with
// a warning (mirroring how unknown style props are ignored) rather than failing
// the parse. Returns null when nothing valid was found, so the caller can fall
// through to line parsing (e.g. a line from an entity literally named "route").
function parseRoute(rest: string): RouteSpec | null {
  const spec: RouteSpec = {};
  let found = false;
  for (const token of splitStyleProps(rest)) {
    const colon = token.indexOf(':');
    // Keys and values are case-insensitive, so normalise both to lower case;
    // `?` is an alias for `auto` wherever `auto` is accepted.
    const key = (colon < 0 ? token : token.slice(0, colon)).toLowerCase();
    const value = (colon < 0 ? '' : token.slice(colon + 1)).trim().toLowerCase();
    switch (key) {
      case 'exit': {
        const side = ROUTE_SIDES.get(value);
        if (value === 'auto' || value === '?') {
          spec.exit = 'auto';
          found = true;
        } else if (side) {
          spec.exit = side;
          found = true;
        } else {
          console.warn(`bpmn: ignoring route exit:${value} (expected n/e/s/w, a compass word, or auto)`);
        }
        break;
      }
      case 'enter': {
        const side = ROUTE_SIDES.get(value);
        if (value === 'auto' || value === '?') {
          spec.enter = 'auto';
          found = true;
        } else if (side) {
          spec.enter = side;
          found = true;
        } else {
          console.warn(`bpmn: ignoring route enter:${value} (expected n/e/s/w, a compass word, or auto)`);
        }
        break;
      }
      case 'depth': {
        if (value === 'auto' || value === '?') {
          spec.depth = 'auto';
          found = true;
          break;
        }
        const n = Number(value);
        if (Number.isInteger(n) && n >= 0) {
          spec.depth = n;
          found = true;
        } else {
          console.warn(`bpmn: ignoring route depth:${value} (expected an integer >= 0 or auto)`);
        }
        break;
      }
      case 'bend':
        // `hvh`/`vhv` are spelled-out aliases for `z`/`n`; `l` is a single corner
        // (HV or VH, oriented off the source edge); `?` for `auto`.
        if (value === 'z' || value === 'hvh') {
          spec.bend = 'z';
          found = true;
        } else if (value === 'n' || value === 'vhv') {
          spec.bend = 'n';
          found = true;
        } else if (value === 'l') {
          spec.bend = 'l';
          found = true;
        } else if (value === 'auto' || value === '?') {
          spec.bend = 'auto';
          found = true;
        } else {
          console.warn(`bpmn: ignoring route bend:${value} (expected z/hvh, n/vhv, l, or auto)`);
        }
        break;
      default:
        console.warn(`bpmn: ignoring unknown route key "${token}"`);
    }
  }
  return found ? spec : null;
}

// Accepts Mermaid's canonical tokens plus friendly aliases. Returns null for
// anything unrecognized so callers can decide how loudly to fail.
function normalizeDirection(token: string): Direction | null {
  switch (token.toLowerCase()) {
    case 'tb':
    case 'td':
    case 'vertical':
      return 'TB';
    case 'bt':
      return 'BT';
    case 'lr':
    case 'horizontal':
      return 'LR';
    case 'rl':
      return 'RL';
    default:
      return null;
  }
}

// --- BPMN entity vocabularies -------------------------------------------------

const ACTIVITY_TYPES = new Map<string, ActivityType>([
  ['task', 'task'],
  ['subprocess', 'subprocess'],
  ['process', 'subprocess'], // alias
  ['call', 'call'],
  ['event-subprocess', 'event-subprocess'],
  ['transaction', 'transaction'],
]);

const TASK_TYPES = new Map<string, TaskType>([
  ['receive', 'receive'],
  ['script', 'script'],
  ['manual', 'manual'],
  ['receive-instance', 'receive-instance'],
  ['service', 'service'],
  ['user', 'user'],
  ['send', 'send'],
  ['rule', 'rule'],
]);

const ACTIVITY_MARKERS = new Map<string, ActivityMarker>([
  ['instance', 'instance'],
  ['loop', 'loop'],
  ['sequential', 'sequential'],
  ['multi', 'sequential'], // alias
  ['parallel', 'parallel'],
  ['compensation', 'compensation'],
  ['adhoc', 'adhoc'],
  ['ad-hoc', 'adhoc'], // alias
]);

const GATE_TYPES = new Map<string, GateType>([
  ['exclusive', 'exclusive'],
  ['inclusive', 'inclusive'],
  ['parallel', 'parallel'],
  ['event', 'event'],
]);

const DATA_TYPES = new Map<string, DataType>([
  ['object', 'object'],
  ['store', 'store'],
  ['collection', 'collection'],
]);

const EVENT_TYPES = new Map<string, EventType>([
  ['blank', 'blank'],
  ['message', 'message'],
  ['timer', 'timer'],
  ['conditional', 'conditional'],
  ['link', 'link'],
  ['signal', 'signal'],
  ['error', 'error'],
  ['escalation', 'escalation'],
  ['termination', 'termination'],
  ['compensation', 'compensation'],
  ['cancel', 'cancel'],
  ['multiple', 'multiple'],
  ['parallel', 'parallel'],
]);

// The four operation words that stand alone: each produces an END event of the
// matching event-type, and its id defaults to the word itself. When followed by a
// real operation, the same word instead reads as the event-type prefix (e.g.
// `error throw x` is a throwing error event), so these overlap EVENT_TYPES.
const ADDITIONAL_OPS = new Map<string, EventType>([
  ['termination', 'termination'],
  ['error', 'error'],
  ['cancel', 'cancel'],
  ['escalation', 'escalation'],
]);

// Reads an event-operation at index `i`, honoring the two-word
// `boundary non-interrupt` / `boundary continue` forms and the `continue` alias
// for `non-interrupt`. Returns null when the token there is not an operation.
function readEventOperation(
  tokens: string[],
  i: number,
): { op: EventOperation; next: number } | null {
  const t = tokens[i];
  switch (t) {
    case 'start':
      return { op: 'start', next: i + 1 };
    case 'end':
      return { op: 'end', next: i + 1 };
    case 'catch':
      return { op: 'catch', next: i + 1 };
    case 'throw':
      return { op: 'throw', next: i + 1 };
    case 'non-interrupt':
    case 'continue':
      return { op: 'non-interrupt', next: i + 1 };
    case 'boundary': {
      const n = tokens[i + 1];
      if (n === 'non-interrupt' || n === 'continue') return { op: 'boundary-non-interrupt', next: i + 2 };
      return { op: 'boundary', next: i + 1 };
    }
    default:
      return null;
  }
}

// A parsed entity declaration, before it is inserted and validated against its
// parent. Family-specific fields are only set for the matching family.
interface EntityDraft {
  type: EntityType;
  name: string;
  label?: string;
  // Set when the declaration ended with a `|` marker: the label is not on this
  // line but on the following, more-indented lines, collected by the main loop.
  multilineLabel?: boolean;
  classes: string[];
  direction?: Direction;
  portSide?: Side;
  activityType?: ActivityType;
  taskType?: TaskType;
  marker?: ActivityMarker;
  gateType?: GateType;
  dataType?: DataType;
  eventType?: EventType;
  eventOperation?: EventOperation;
  boundarySide?: Side | 'auto';
  bracketSide?: Side;
}

// Classifies a declaration line into a BPMN entity draft, or returns null when it
// is not a recognizable entity (so the caller falls through to "unknown line").
// Throws for a line that clearly IS an entity but is malformed (a port without a
// direction, or a port carrying a label).
function matchEntity(line: string): EntityDraft | null {
  const { label, rest } = extractLabel(line);
  const [declPart, classPart] = rest.split(INLINE_CLASS_SEP, 2);
  const classes = classPart ? classPart.trim().split(/\s+/) : [];
  const rawTokens = declPart.trim() ? declPart.trim().split(/\s+/) : [];
  // A lone `|` token (in place of a quoted label) marks a multi-line label that
  // follows on the next indented lines. It is peeled off here so the family
  // grammars below never see it; the main loop collects the label text.
  const multilineLabel = rawTokens.includes('|');
  const tokens = multilineLabel ? rawTokens.filter((t) => t !== '|') : rawTokens;
  if (tokens.length === 0) return null;
  const lc = tokens.map((t) => t.toLowerCase());

  const draft = (type: EntityType): EntityDraft => {
    const d: EntityDraft = { type, name: '', classes };
    if (label !== undefined) d.label = label;
    if (multilineLabel) d.multilineLabel = true;
    return d;
  };

  // gate: `<gate-type?> gate <id?>`
  if (lc[0] === 'gate' || (GATE_TYPES.has(lc[0]) && lc[1] === 'gate')) {
    const gi = lc[0] === 'gate' ? 0 : 1;
    const d = draft('gate');
    if (gi === 1) {
      const gt = GATE_TYPES.get(lc[0]) as GateType;
      if (gt !== 'exclusive') d.gateType = gt;
    }
    d.name = tokens.slice(gi + 1).join(' ');
    return d;
  }

  // pool / lane / region / group: `<kw> <id?> "<label?>" <direction?>`
  if (lc[0] === 'pool' || lc[0] === 'lane' || lc[0] === 'region' || lc[0] === 'group') {
    const d = draft(lc[0] as EntityType);
    const words = tokens.slice(1);
    if (words.length) {
      const dir = normalizeDirection(words[words.length - 1]);
      if (dir) {
        d.direction = dir;
        words.pop();
      }
    }
    d.name = words.join(' ');
    return d;
  }

  // text (comment): `comment <id?> <bracket-side?>` — like a port, the optional
  // trailing token is a compass SIDE (n/e/s/w or a compass word), or `auto`/`?`
  // (the default), fixing which edge draws the open bracket. It holds only ports.
  if (lc[0] === 'comment') {
    const d = draft('text');
    const words = tokens.slice(1);
    if (words.length) {
      const last = words[words.length - 1].toLowerCase();
      if (last === 'auto' || last === '?') {
        words.pop(); // explicit auto — same as omitting it
      } else {
        const side = ROUTE_SIDES.get(last);
        if (side) {
          d.bracketSide = side;
          words.pop();
        }
      }
    }
    d.name = words.join(' ');
    return d;
  }

  // port: `port <id?> <direction>` — direction required, no label, never at root
  // (the root check happens once the parent is known).
  if (lc[0] === 'port') {
    if (label !== undefined || multilineLabel) {
      throw new Error(`bpmn: a port cannot have a label (found "${line}")`);
    }
    const words = tokens.slice(1);
    const side = words.length ? ROUTE_SIDES.get(words[words.length - 1].toLowerCase()) : undefined;
    if (!side) {
      throw new Error(
        `bpmn: a port needs a trailing direction (n/e/s/w or a compass word) (found "${line}")`,
      );
    }
    const d = draft('port');
    d.portSide = side;
    d.name = words.slice(0, -1).join(' ');
    return d;
  }

  // data: `data <data-type?> <id?>`
  if (lc[0] === 'data') {
    const d = draft('data');
    let i = 1;
    const dt = DATA_TYPES.get(lc[1] ?? '');
    if (dt) {
      if (dt !== 'object') d.dataType = dt;
      i = 2;
    }
    d.name = tokens.slice(i).join(' ');
    return d;
  }

  // activity: `<marker?> <task-type?> <activity-type> <id?>`
  {
    let i = 0;
    let marker: ActivityMarker | undefined;
    let taskType: TaskType | undefined;
    const m = ACTIVITY_MARKERS.get(lc[i] ?? '');
    if (m) {
      marker = m;
      i++;
    }
    const tt = TASK_TYPES.get(lc[i] ?? '');
    if (tt) {
      taskType = tt;
      i++;
    }
    const at = ACTIVITY_TYPES.get(lc[i] ?? '');
    if (at) {
      i++;
      const d = draft('activity');
      d.activityType = at;
      if (taskType) d.taskType = taskType;
      if (marker && marker !== 'instance') d.marker = marker;
      d.name = tokens.slice(i).join(' ');
      return d;
    }
  }

  // event: `<event-type?> <event-operation> <id?>` (plus the standalone
  // additional operations, which are end events of their own type).
  {
    let i = 0;
    let eventType: EventType | undefined;
    let op: EventOperation;
    let defaultId: string | undefined;
    const first = lc[0];

    if (ADDITIONAL_OPS.has(first)) {
      const after = readEventOperation(lc, 1);
      eventType = ADDITIONAL_OPS.get(first);
      if (after) {
        // e.g. `error throw x` — the word is the event-type, then an operation.
        op = after.op;
        i = after.next;
      } else {
        // e.g. `error`, `cancel done` — the word IS the operation: an end event
        // of that type, whose id defaults to the word.
        op = 'end';
        i = 1;
        defaultId = first;
      }
    } else if (EVENT_TYPES.has(first)) {
      const o = readEventOperation(lc, 1);
      if (!o) return null; // an event-type with no valid operation is not an event
      eventType = EVENT_TYPES.get(first);
      op = o.op;
      i = o.next;
    } else {
      const o = readEventOperation(lc, 0);
      if (!o) return null;
      op = o.op;
      i = o.next;
    }

    const d = draft('event');
    if (eventType && eventType !== 'blank') d.eventType = eventType;
    d.eventOperation = op;
    // A boundary event optionally carries a trailing direction, like a port:
    // `message boundary catch e1 s` pins it to the south side; `auto`/`?` (or an
    // omitted direction) lets the renderer derive the side from the host activity's
    // layout direction. The token is peeled off before the id is read, so it never
    // becomes the id (mirroring how a port's trailing direction works).
    let idTokens = tokens.slice(i);
    if (op === 'boundary' || op === 'boundary-non-interrupt') {
      const last = idTokens.length ? idTokens[idTokens.length - 1].toLowerCase() : '';
      if (last === 'auto' || last === '?') {
        d.boundarySide = 'auto';
        idTokens = idTokens.slice(0, -1);
      } else if (ROUTE_SIDES.has(last)) {
        d.boundarySide = ROUTE_SIDES.get(last);
        idTokens = idTokens.slice(0, -1);
      }
    }
    let id = idTokens.join(' ');
    if (id === '') {
      if (op === 'start') id = 'start';
      else if (op === 'end') id = defaultId ?? 'end';
      // The id was synthesized from the operation/type, not written by the author,
      // so it must not leak into the drawn caption. Only an explicit id (or an
      // explicit quoted label) becomes a caption; an auto-id draws nothing.
      if (d.label === undefined) d.label = '';
    }
    d.name = id;
    return d;
  }
}

// --- nesting rules ------------------------------------------------------------

const FLOW_CHILDREN: ReadonlySet<EntityType> = new Set<EntityType>([
  'activity',
  'gate',
  'data',
  'event',
  'region',
  'group',
  'text',
  'port',
]);
// The diagram root also accepts the swimlane containers and bare flow elements
// (a pool-less process), plus regions, groups, and text annotations.
const ROOT_CHILDREN: ReadonlySet<EntityType> = new Set<EntityType>([
  'pool',
  'lane',
  'region',
  'group',
  'activity',
  'gate',
  'data',
  'event',
  'text',
]);
const POOL_CHILDREN: ReadonlySet<EntityType> = new Set<EntityType>(['lane']);
// task / call activities: only boundary events nest inside them.
const ATOMIC_ACTIVITY_CHILDREN: ReadonlySet<EntityType> = new Set<EntityType>(['event']);
// A text annotation holds only ports (an edge anchor is its only valid child).
const TEXT_CHILDREN: ReadonlySet<EntityType> = new Set<EntityType>(['port']);
const NO_CHILDREN: ReadonlySet<EntityType> = new Set<EntityType>();

function isContainerActivity(entity: Entity): boolean {
  return entity.type === 'activity'
    && entity.activityType !== undefined
    && ACTIVITY_CONTAINER_TYPES.has(entity.activityType);
}

function allowedChildTypes(parent: Entity, root: Entity): ReadonlySet<EntityType> {
  if (parent === root) return ROOT_CHILDREN;
  switch (parent.type) {
    case 'pool':
      return POOL_CHILDREN;
    case 'lane':
    case 'region':
    case 'group':
      return FLOW_CHILDREN;
    case 'activity':
      return isContainerActivity(parent) ? FLOW_CHILDREN : ATOMIC_ACTIVITY_CHILDREN;
    case 'text':
      return TEXT_CHILDREN;
    default: // gate, data, event, port
      return NO_CHILDREN;
  }
}

// --- auto-sequencing ----------------------------------------------------------

// The flow families that auto-sequencing chains together. Data, region, group,
// port, and the swimlane containers are neither linked nor treated as a "next"
// target.
const AUTO_SEQUENCE_TYPES: ReadonlySet<EntityType> = new Set<EntityType>([
  'activity',
  'gate',
  'event',
]);

// Resolves a line endpoint (a name or a direct Entity) against a name index.
// First-declaration-wins, matching how lines are resolved elsewhere.
function resolveEndpoint(ep: Entity | string, index: Map<string, Entity>): Entity | undefined {
  return typeof ep === 'string' ? index.get(ep) : ep;
}

// After the tree and every explicit line exist, connects unlinked flow children
// in declaration order within each container whose auto-sequence is on. The value
// is inherited: a container uses its own `autoSequence` if set, else the value it
// inherited (root default off). For each container that is on, every child that is
// an activity/gate/event and has no outgoing line is linked to the next such
// sibling. An end event is never given an outgoing line — it is a flow terminus.
// Boundary events are excluded outright — like data, they are never a sequence
// source, a "next" target, or a line's counted destination — since they attach to
// an activity rather than sitting in the flow.
// Existing lines determine "has an outgoing line": the tail is the source of
// `-->`, the target of `<--`, and either endpoint of an undirected `---`. A line
// does not count as an outgoing line — leaving the tail free to sequence to its
// next sibling — when its destination is a data element or boundary event, or when
// it crosses into a different pool than the tail (data-association / message-flow).
function applyAutoSequencing(root: Entity): void {
  const index = new Map<string, Entity>();
  // The enclosing pool of each entity (undefined for entities outside any pool),
  // so a line's endpoints can be compared for a pool crossing.
  const poolOf = new Map<Entity, Entity | undefined>();
  const build = (e: Entity, pool: Entity | undefined): void => {
    if (e.name && !index.has(e.name)) index.set(e.name, e);
    poolOf.set(e, pool);
    const childPool = e.type === 'pool' ? e : pool;
    e.children.forEach((c) => build(c, childPool));
  };
  root.children.forEach((e) => build(e, undefined));

  // A boundary event attaches to an activity rather than sitting in the flow, so
  // it is excluded from sequencing exactly like a data element.
  const isExcluded = (e: Entity): boolean =>
    e.type === 'data' ||
    (e.type === 'event' && !!e.eventOperation && BOUNDARY_OPERATIONS.has(e.eventOperation));

  // Whether a line from `tail` to `dest` counts as an outgoing line for `tail`:
  // the destination must exist, not be excluded (data / boundary), and share the
  // tail's pool.
  const counts = (tail: Entity | undefined, dest: Entity | undefined): boolean =>
    !!tail && !!dest && !isExcluded(dest) && poolOf.get(tail) === poolOf.get(dest);

  const hasOutgoing = new Set<Entity>();
  for (const line of db.getLines()) {
    const source = resolveEndpoint(line.source, index);
    const target = resolveEndpoint(line.target, index);
    if (line.type === '-->') {
      if (counts(source, target)) hasOutgoing.add(source!);
    } else if (line.type === '<--') {
      if (counts(target, source)) hasOutgoing.add(target!);
    } else {
      if (counts(source, target)) hasOutgoing.add(source!);
      if (counts(target, source)) hasOutgoing.add(target!);
    }
  }

  // A flow terminus never gets an outgoing line auto-sequenced (it can still be a
  // sequence target): an end event, or a link THROW event — the "go to" end of a
  // link pair, which continues at its matching link catch rather than the next
  // sibling.
  const isTerminus = (e: Entity): boolean =>
    e.type === 'event' &&
    (e.eventOperation === 'end' ||
      (e.eventType === 'link' && e.eventOperation === 'throw'));
  // A flow node eligible to be sequenced from or to: an activity/gate/event that
  // is not a boundary event (those attach to an activity, off the flow).
  const isSequenceable = (e: Entity): boolean =>
    AUTO_SEQUENCE_TYPES.has(e.type) && !isExcluded(e);

  const walk = (container: Entity, inherited: boolean): void => {
    const effective = container.autoSequence ?? inherited;
    if (effective) {
      const kids = container.children;
      for (let i = 0; i < kids.length; i++) {
        const from = kids[i];
        if (!isSequenceable(from) || hasOutgoing.has(from)) continue;
        if (isTerminus(from)) continue;
        const to = kids.slice(i + 1).find(isSequenceable);
        if (!to) continue;
        db.addLine(from, to, '-->', container === root ? null : container);
        hasOutgoing.add(from);
      }
    }
    for (const child of container.children) walk(child, effective);
  };
  walk(root, false);
}

export const parser = {
  parse(text: string): void {
    db.clear();

    // The root frame: indent -1 is shallower than any real line, and its entity is
    // the diagram root. Diagram-scoped statements (bare `style`, `route`,
    // `direction`) then attach to it exactly like they would to any entity.
    const root = db.getRoot();
    const stack: Frame[] = [{ indent: -1, entity: root, styleTarget: root }];

    // A single unnamed pool is inserted the first time a lane is declared at the
    // diagram root, and every subsequent root-level lane joins it.
    let autoPool: Entity | null = null;
    const getAutoPool = (): Entity => {
      if (!autoPool) autoPool = db.addEntity('', 'pool', root);
      return autoPool;
    };

    // Complex lines are collected and expanded after the tree is fully built,
    // since resolving absolute endpoints may reference entities declared later.
    const complexSpecs: ComplexLineSpec[] = [];

    // Popping an entity frame is where its entity-wide `route` (if any) lands on
    // the lines anywhere in its subtree. The default is merged UNDER whatever the
    // line already carries, so a line's own `route` — and any closer entity's,
    // which flushed earlier (deeper frames pop first) — wins per key.
    const flushFrame = (frame: Frame): void => {
      if (!frame.entityRoute || !frame.entityLines) return;
      for (const target of frame.entityLines) {
        target.routing = { ...frame.entityRoute, ...(target.routing ?? {}) };
      }
    };

    const rawLines = text.split(/\r?\n/);
    for (let li = 0; li < rawLines.length; li++) {
      const raw = rawLines[li];
      const indent = raw.length - raw.trimStart().length;
      const line = raw.trim();

      // Skip blanks and comments.
      if (line === '' || line.startsWith('%%') || line.startsWith('#')) {
        continue;
      }

      // The `bpmn` header sits at the root and may carry a diagram direction,
      // mirroring flowchart's `flowchart LR`. It never nests entities itself.
      const header = HEADER_RE.exec(line);
      if (header) {
        if (header[1]) {
          const dir = normalizeDirection(header[1]);
          if (dir) db.setDirection(dir);
        }
        continue;
      }

      // Pop frames until the top is strictly shallower than this line; that
      // frame is our enclosing container. Flush each popped frame so an entity's
      // `route` reaches the lines in its subtree.
      while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
        flushFrame(stack.pop() as Frame);
      }
      const parent = stack[stack.length - 1].entity;

      // `debug ports` toggles the port overlay. It only makes sense at the
      // diagram root (directly under `bpmn`); nested it is dropped with a warning.
      if (DEBUG_PORTS_RE.test(line)) {
        if (parent !== root) {
          console.warn(`bpmn: "debug ports" is only allowed at the diagram root ("${line}")`);
        } else {
          db.setDebugPorts(true);
        }
        continue;
      }

      const direction = DIRECTION_RE.exec(line);
      if (direction) {
        const dir = normalizeDirection(direction[1]);
        // A `direction` statement applies to the container it is nested in
        // (parent), or the diagram default when at the top level.
        if (dir) db.setDirection(dir, parent);
        continue;
      }

      // `auto-sequence <on|off>` applies to the container it is nested in
      // (parent), or the diagram root at the top level. A bare directive is `on`.
      // The value is resolved with inheritance after the tree is built.
      const autoSeq = AUTO_SEQUENCE_RE.exec(line);
      if (autoSeq) {
        parent.autoSequence = autoSeq[1] ? autoSeq[1].toLowerCase() === 'on' : true;
        continue;
      }

      // `classDef <name> <props>` — a reusable named style bag.
      const classDef = CLASSDEF_RE.exec(line);
      if (classDef) {
        const props = parseProps(splitStyleProps(classDef[2]));
        if (props) {
          db.addClassDef(classDef[1], props);
          continue;
        }
      }

      // `class <names> <class>` — attach one class to comma-separated names.
      const classStmt = CLASS_RE.exec(line);
      if (classStmt) {
        const targets = classStmt[1].split(',').map((s) => s.trim()).filter(Boolean);
        for (const target of targets) db.addNamedClasses(target, [classStmt[2]]);
        continue;
      }

      // `style …` — by name (`style <name> <props>`) or, with no name, the
      // entity/line this statement is nested under.
      const styleStmt = STYLE_RE.exec(line);
      if (styleStmt) {
        const parsed = splitNameAndProps(styleStmt[1]);
        if (parsed) {
          if (parsed.name) {
            db.addNamedStyle(parsed.name, parsed.style);
          } else {
            // A bare `style` attaches to the entity or line it is nested under —
            // the top frame's styleTarget. At the diagram root that target is the
            // root entity, so a root-level bare `style` sets the diagram-wide
            // default with no special case (every frame carries a styleTarget).
            const target = stack[stack.length - 1].styleTarget;
            if (target) applyStyle(target, parsed.style);
          }
          continue;
        }
        // No trailing props: not a style statement — fall through (e.g. a line
        // whose first endpoint is literally named "style").
      }

      // `route <props>` — layout hints. Nested directly under a line it tunes that
      // one line; nested directly under an entity it sets a default for every line
      // declared in that entity; at the diagram root it sets a diagram-wide default
      // for every line (both applied on flush, see flushFrame). Parsed before line
      // patterns so it isn't mistaken for a line; if it doesn't parse to any valid
      // key it falls through (a line from an entity named "route").
      const routeStmt = ROUTE_RE.exec(line);
      if (routeStmt) {
        const spec = parseRoute(routeStmt[1]);
        if (spec) {
          const frame = stack[stack.length - 1];
          if (frame.routeTarget) {
            // A `route` nested under a line tunes that one line.
            applyRoute(frame.routeTarget, spec);
          } else {
            // Otherwise the top frame is an entity (the diagram root included), so
            // it sets a subtree-wide — or, at the root, diagram-wide — default.
            frame.entityRoute = { ...(frame.entityRoute ?? {}), ...spec };
          }
          continue;
        }
        // No valid route key: fall through to line parsing.
      }

      // A line that omits an endpoint borrows the enclosing entity for it, so it
      // has to be nested inside a real entity — the root (a structural region) is
      // not a valid endpoint.
      const enclosing = (): Entity => {
        if (parent === root) {
          throw new Error(`bpmn: a relative line ("${line}") needs an enclosing entity`);
        }
        return parent;
      };

      // Each line pushes a frame so a `style` nested under it can attach: the
      // frame keeps `entity` at the line's own enclosing container (so relative
      // resolution and deeper nesting are unchanged) and points `styleTarget` at
      // the line/spec. A relative line records its enclosing container so it can
      // inherit that container's stroke; an absolute line records none and later
      // inherits from its endpoints' common ancestor. The line is also registered
      // with every ancestor entity frame so an entity-wide `route` anywhere above
      // reaches it; frames flush deepest-first, so a closer entity's route wins.
      const pushLineFrame = (target: Styleable & Routable): void => {
        for (const frame of stack) (frame.entityLines ??= []).push(target);
        stack.push({ indent, entity: parent, styleTarget: target, routeTarget: target });
      };

      // A line may carry a quoted label at the end (`A --> B "text"`). Peel it off
      // before matching the connector so the label text never disturbs the scan;
      // the remaining body is what the line patterns below parse. When no line
      // matches, the ORIGINAL line falls through to matchEntity, which does its own
      // label handling — so an entity declaration's label is untouched.
      const { label: lineLabel, rest: lineBody } = extractLabel(line);
      // Attaches the peeled label to a stored line, when present.
      const withLabel = (l: ReturnType<typeof db.addLine>): typeof l => {
        if (lineLabel !== undefined) l.label = lineLabel;
        return l;
      };

      // Complex lines are chains of two or more arrows linking named entities.
      // They must be matched before the plain-line patterns, whose greedy tail
      // would otherwise swallow later arrows as part of an entity name. A
      // single-arrow line, or one that does not tokenise cleanly, falls through to
      // the plain-line trio below.
      const chain = scanChain(lineBody);
      if (chain && chain.arrows.length >= 2) {
        const last = chain.nodes.length - 1;
        // An empty node is an omitted endpoint (relative line); it may only sit
        // at an end. An interior empty means malformed input — not a complex
        // line, so fall through rather than error.
        const interiorEmpty = chain.nodes.some(
          (n, i) => n.kind === 'empty' && i !== 0 && i !== last,
        );
        if (!interiorEmpty) {
          const relative = chain.nodes[0].kind === 'empty' || chain.nodes[last].kind === 'empty';
          const toNode = (n: ScanNode): ChainNode =>
            n.kind === 'empty' ? { entity: enclosing() } : { entity: n.name };
          const spec: ComplexLineSpec = {
            nodes: chain.nodes.map(toNode),
            arrows: chain.arrows,
          };
          // Per-arrow slash decorations, carried only when at least one segment
          // has one so a slash-free chain's spec stays minimal (test equality).
          if (chain.slashes.some(Boolean)) spec.slashes = chain.slashes;
          // A chain's label rides on its first segment (see expandComplexLines).
          if (lineLabel !== undefined) spec.label = lineLabel;
          // A relative chain inherits its enclosing container's stroke; an
          // absolute one falls back to the endpoints' common ancestor.
          if (relative) spec.container = parent;
          complexSpecs.push(spec);
          pushLineFrame(spec);
          continue;
        }
      }

      // Plain lines, in the same leading / trailing / absolute trio. Each may
      // carry a slash on either end (see slashEnds); it is attached to the stored
      // line, left off when absent so line equality in tests is unaffected.
      const withSlash = (l: ReturnType<typeof db.addLine>, conn: string): typeof l => {
        const slash = slashEnds(conn);
        if (slash) l.slash = slash;
        return l;
      };

      const leadLine = LEAD_LINE_RE.exec(lineBody);
      if (leadLine) {
        pushLineFrame(
          withLabel(withSlash(db.addLine(enclosing(), leadLine[2].trim(), arrowType(leadLine[1]), parent), leadLine[1])),
        );
        continue;
      }

      const trailLine = TRAIL_LINE_RE.exec(lineBody);
      if (trailLine) {
        pushLineFrame(
          withLabel(withSlash(db.addLine(trailLine[1].trim(), enclosing(), arrowType(trailLine[2]), parent), trailLine[2])),
        );
        continue;
      }

      const absLine = ABS_LINE_RE.exec(lineBody);
      if (absLine) {
        pushLineFrame(
          withLabel(withSlash(db.addLine(absLine[1].trim(), absLine[3].trim(), arrowType(absLine[2])), absLine[2])),
        );
        continue;
      }

      // An entity declaration. Matched after lines so a line whose endpoint is
      // named like a keyword still reads as a line (entity decls carry no arrows).
      const draft = matchEntity(line);
      if (draft) {
        // A root-level lane is reparented into a shared, auto-inserted pool.
        const effParent = draft.type === 'lane' && parent === root ? getAutoPool() : parent;

        const allowed = allowedChildTypes(effParent, root);
        if (!allowed.has(draft.type)) {
          const where = effParent === root ? 'the diagram root' : `a ${effParent.type}`;
          throw new Error(`bpmn: ${where} cannot contain a ${draft.type} (found "${line}")`);
        }
        // task / call activities accept only boundary events.
        if (
          effParent.type === 'activity' &&
          !isContainerActivity(effParent) &&
          !(draft.eventOperation && BOUNDARY_OPERATIONS.has(draft.eventOperation))
        ) {
          throw new Error(
            `bpmn: a ${effParent.activityType} activity can only contain boundary events (found "${line}")`,
          );
        }

        const node = db.addEntity(draft.name, draft.type, effParent);
        if (draft.label !== undefined) node.label = draft.label;
        // A `|` marker collects the following, more-indented lines as the label.
        // The first such line fixes the base indent; deeper lines keep the extra
        // spaces; the label ends at the first line indented no deeper than it (a
        // line still under the entity, but shallower than the label, nests as a
        // child as usual). Blank lines are kept verbatim between label lines.
        if (draft.multilineLabel) {
          let base: number | null = null;
          let last = li;
          for (let peek = li + 1; peek < rawLines.length; peek++) {
            const l = rawLines[peek];
            if (l.trim() === '') continue;
            const ind = l.length - l.trimStart().length;
            if (base === null) {
              // The first label line must sit deeper than the entity; if it does
              // not, there is no label content (an explicit empty label).
              if (ind <= indent) break;
              base = ind;
            }
            if (ind < base) break;
            last = peek;
          }
          if (base !== null && last > li) {
            const parts: string[] = [];
            for (let k = li + 1; k <= last; k++) {
              const l = rawLines[k];
              parts.push(l.trim() === '' ? '' : l.slice(base));
            }
            node.label = applyNewlineEscapes(parts.join('\n'));
          } else {
            node.label = '';
          }
          li = last;
        }
        if (draft.classes.length > 0) node.classes = draft.classes;
        if (draft.direction) node.direction = draft.direction;
        if (draft.portSide) node.portSide = draft.portSide;
        if (draft.activityType) node.activityType = draft.activityType;
        if (draft.taskType) node.taskType = draft.taskType;
        if (draft.marker) node.marker = draft.marker;
        if (draft.gateType) node.gateType = draft.gateType;
        if (draft.dataType) node.dataType = draft.dataType;
        if (draft.eventType) node.eventType = draft.eventType;
        if (draft.eventOperation) node.eventOperation = draft.eventOperation;
        if (draft.boundarySide) node.boundarySide = draft.boundarySide;
        if (draft.bracketSide) node.bracketSide = draft.bracketSide;
        stack.push({ indent, entity: node, styleTarget: node });
        continue;
      }

      // Unknown line: ignore for now. A stricter mode can throw here later.
    }

    // Flush any frames still open at EOF (deepest first) so their entity-wide
    // routes land — including on complex-line specs, whose routing must be set
    // before expansion propagates it onto the generated segments below. The root
    // frame is flushed last (it is never popped), so a diagram-wide `route` is
    // merged UNDER everything a closer frame already set.
    while (stack.length > 1) flushFrame(stack.pop() as Frame);
    flushFrame(stack[0]);

    // Tree is complete: expand each complex line into one segment per arrow,
    // carrying over any stroke/container/routing/slash the complex line set.
    for (const generated of expandComplexLines(db.getEntities(), complexSpecs)) {
      const line = db.addLine(
        generated.source,
        generated.target,
        generated.type,
        generated.container ?? null,
      );
      if (generated.slash) line.slash = generated.slash;
      if (generated.label !== undefined) line.label = generated.label;
      if (generated.style) line.style = generated.style;
      if (generated.routing) line.routing = generated.routing;
    }

    // With the tree and all explicit lines in place, auto-connect unlinked flow
    // children in every container whose (inherited) auto-sequence is on.
    applyAutoSequencing(root);
  },
};

interface Frame {
  indent: number;
  // The container these lines nest under. The root frame's entity is the diagram
  // root, so every frame has one — "diagram scope" is just the outermost entity.
  entity: Entity;
  // What a bare `style` nested directly here applies to: the enclosing entity,
  // or a line/complex-line when the frame was pushed for one. A line frame keeps
  // `entity` pointing at the line's own enclosing container, so deeper nesting
  // and relative-line resolution are unchanged.
  styleTarget?: Styleable;
  // What a `route` nested directly under a LINE applies to: the line/complex-line
  // itself. Only line frames set this.
  routeTarget?: Routable;
  // A `route` nested directly under an ENTITY (the diagram root included) sets a
  // default applied to every line anywhere in that subtree (`entityLines`) when
  // the frame is popped/flushed. A line's own `route`, and any closer entity's
  // (the root's being outermost of all), win per key — frames flush deepest-first
  // and the default is merged UNDER what's there.
  entityRoute?: RouteSpec;
  entityLines?: Routable[];
}
