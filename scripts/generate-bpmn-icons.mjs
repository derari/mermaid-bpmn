// Regenerates src/bpmnIcons.ts from the MDI (Material Design Icons, Pictogrammers,
// Apache-2.0) source in the @iconify-json/mdi devDependency. Run: `node scripts/generate-bpmn-icons.mjs`.
//
// It resolves each borrowed MDI icon (aliases and transforms included) and emits a
// small self-contained Iconify pack keyed by our BPMN-friendly names. This is the
// only place the full MDI pack is touched — it is a build-time devDependency and is
// never shipped; only the tiny generated subset below ships.
import { getIconData } from '@iconify/utils';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const mdi = JSON.parse(
  readFileSync(fileURLToPath(new URL('../node_modules/@iconify-json/mdi/icons.json', import.meta.url))),
);

// bpmn name  <-  MDI source name  (+ optional per-icon transform)
const MAP = [
  // activity task-type glyphs
  { name: 'receive', from: 'envelope-outline' },
  { name: 'send', from: 'envelope' },
  { name: 'script', from: 'script-text-outline' },
  { name: 'manual', from: 'hand-back-left-outline', rotate: 1 }, // 90° clockwise
  { name: 'service', from: 'cog-outline' },
  { name: 'user', from: 'person-outline' },
  { name: 'rule', from: 'view-list-outline' },
  // activity loop marker (the multi-instance bar markers are hand-drawn below).
  // Mirrored on its vertical axis (hFlip) so the arrow curls the BPMN way.
  { name: 'loop', from: 'loop', hFlip: true },
  // event-type markers, -in (catching) / -out (throwing) variants. The MDI-derived
  // ones reuse the same sources as some task-type glyphs (copied — the pack has no
  // alias mechanism).
  { name: 'message-in', from: 'envelope-outline' },
  { name: 'message-out', from: 'envelope' },
  { name: 'conditional-in', from: 'view-list-outline' },
  { name: 'conditional-out', from: 'view-list' },
  { name: 'timer-in', from: 'clock-time-four-outline' },
  { name: 'timer-out', from: 'clock-time-four' },
  { name: 'link-in', from: 'arrow-right-bold-outline' },
  { name: 'link-out', from: 'arrow-right-bold' },
  { name: 'error-in', from: 'flash-outline' },
  { name: 'error-out', from: 'flash' },
  // The rewind glyph reads small next to the other markers, so grow it to fill the
  // circle; the outline variant also needs a 1px left nudge to sit centred.
  { name: 'compensation-in', from: 'rewind-outline', grow: 6, dx: -1 },
  { name: 'compensation-out', from: 'rewind', grow: 4 },
];

// Hand-drawn markers (BPMN gate types and event types), on the same 24×24 canvas
// as MDI so they scale the same way. Not from MDI — authored here as plain SVG
// bodies, so they are covered by this project's own (MIT) license, not Apache-2.0.

// Shared marker outlines (24×24, centred at 12), each spanning ~20 units.
const TRI = '12,2 22,21 2,21'; // triangle (signal)
const ARROWHEAD = '12,2 22,21 12,15 2,21'; // up arrowhead (escalation)
const PENTAGON = '12,2 21.5,8.9 17.9,20.1 6.1,20.1 2.5,8.9'; // pentagon (multiple)
// a plus/cross (parallel); rotated 45° it becomes an X (cancel)
const CROSS = '9.5,0 14.5,0 14.5,9.5 24,9.5 24,14.5 14.5,14.5 14.5,24 9.5,24 9.5,14.5 0,14.5 0,9.5 9.5,9.5';

// Fine-tuning transforms wrapped around a glyph body: `grow` (px added to the
// 24-unit canvas, scaled about the centre) and `dx`/`dy` (a px shift). The shift
// wraps the (possibly scaled) body, so it nudges the glyph as finally sized.
// `scale(s)` about (12,12) reduces to a leading translate of 12*(1-s) = -grow/2.
function adjust(body, { grow = 0, dx = 0, dy = 0 } = {}) {
  let out = body;
  if (grow) {
    const t = -grow / 2;
    out = `<g transform="translate(${t} ${t}) scale(${(24 + grow) / 24})">${out}</g>`;
  }
  if (dx || dy) out = `<g transform="translate(${dx} ${dy})">${out}</g>`;
  return out;
}

// An event-type marker comes in two variants: `<name>-in` catching (outline,
// stroke-width 1.25, no fill) and `<name>-out` throwing (solid, filled). `open`
// is the shape's opening tag up to (but not including) fill/stroke. An optional
// `adj` (see adjust) fine-tunes both variants identically.
function markerPair(name, open, adj) {
  return {
    [`${name}-in`]: {
      body: adjust(`${open} fill="none" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/>`, adj),
    },
    [`${name}-out`]: { body: adjust(`${open} fill="currentColor"/>`, adj) },
  };
}

// The two crossing strokes shared by the gateway markers: exclusive is the "X"
// (kept 4px smaller than the others so its thick strokes clear), parallel is the
// "+", and complex overlays the two into an asterisk.
const X_STROKE =
  '<path fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" d="M4 4l16 16M20 4L4 20"/>';
const PLUS_STROKE =
  '<path fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" d="M12 2v20M2 12h20"/>';

const LITERAL = {
  // exclusive: an "X"
  exclusive: { body: X_STROKE },
  // inclusive: a ring "O" (diameter ~20)
  inclusive: {
    body: '<circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="4"/>',
  },
  // parallel: a plus "+" spanning ~20
  parallel: { body: PLUS_STROKE },
  // complex: an asterisk — the exclusive "X" overlaid on the parallel "+"
  complex: { body: X_STROKE + PLUS_STROKE },
  // event: a pentagon inside a thin double circle (the BPMN event-based gateway)
  event: {
    body:
      '<circle cx="12" cy="12" r="11.5" fill="none" stroke="currentColor" stroke-width="1"/>' +
      '<circle cx="12" cy="12" r="9.5" fill="none" stroke="currentColor" stroke-width="1"/>' +
      '<polygon points="12,5 18.7,9.8 16.1,17.7 7.9,17.7 5.3,9.8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>',
  },

  // event-type markers with no MDI source, drawn here. `-in` (catching) is an
  // outline (stroke-width 1.25, no fill); `-out` (throwing) is solid (filled). The
  // shared point strings keep each pair identical bar the fill/stroke.
  //   signal — triangle; escalation — up arrowhead; multiple — pentagon;
  //   parallel — plus; cancel — plus rotated 45° (an X); termination — a disc.
  ...markerPair('signal', `<polygon points="${TRI}"`, { dy: -1 }),
  ...markerPair('escalation', `<polygon points="${ARROWHEAD}"`, { dy: -1 }),
  ...markerPair('multiple', `<polygon points="${PENTAGON}"`),
  ...markerPair('parallel', `<polygon points="${CROSS}"`),
  ...markerPair('cancel', `<polygon points="${CROSS}" transform="rotate(45 12 12)"`),
  'termination-out': { body: '<circle cx="12" cy="12" r="12" fill="currentColor"/>' },

  // Activity multi-instance markers (BPMN loop characteristics). `loop` is the
  // MDI glyph above; these two are the bar markers, hand-drawn as three parallel
  // strokes. Named `mi-<kind>` so the multi-instance `parallel` does not collide
  // with the `parallel` gateway (a "+") or the `parallel` event markers. Per the
  // BPMN spec: three horizontal bars for sequential, three vertical bars for parallel.
  'mi-sequential': {
    body: '<path fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" d="M4 6h16M4 12h16M4 18h16"/>',
  },
  'mi-parallel': {
    body: '<path fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" d="M6 4v16M12 4v16M18 4v16"/>',
  },
  // ad-hoc marker: a tilde (~), the BPMN ad-hoc sub-process glyph — two half-waves,
  // up on the left and down on the right, centred on the 24×24 canvas.
  adhoc: {
    body: '<path fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" d="M4 12q4 -7 8 0t8 0"/>',
  },
  // Collapsed marker for a composite (expandable) activity drawn without its
  // children — a small square with a plus, the BPMN "expand" affordance. Distinct
  // from the `parallel` gateway "+" by its enclosing box.
  composite: {
    body:
      '<rect x="3" y="3" width="18" height="18" rx="1" fill="none" stroke="currentColor" stroke-width="2"/>' +
      '<path d="M12 7v10M7 12h10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  },
};

const icons = {};
for (const { name, from, rotate, hFlip, vFlip, grow, dx, dy } of MAP) {
  const data = getIconData(mdi, from);
  if (!data) throw new Error(`MDI icon not found: ${from}`);
  // getIconData resolves aliases and folds in any inherited transform; the body is
  // ready to draw. We keep only the pieces our renderer needs (see icons.ts). A
  // requested flip toggles (XOR) any flip the source already carries. `grow`/`dx`/`dy`
  // (see adjust) wrap the body; Iconify's own rotate/flip below wrap that in turn, and
  // rotate/flip are isometric about the centre, so the grow/nudge survive unchanged.
  const entry = { body: adjust(data.body, { grow, dx, dy }) };
  if (data.width !== 24) entry.width = data.width;
  if (data.height !== 24) entry.height = data.height;
  if (data.rotate) entry.rotate = ((data.rotate + (rotate ?? 0)) % 4);
  else if (rotate) entry.rotate = rotate;
  if (Boolean(data.hFlip) !== Boolean(hFlip)) entry.hFlip = true;
  if (Boolean(data.vFlip) !== Boolean(vFlip)) entry.vFlip = true;
  icons[name] = entry;
}

// The hand-drawn gateway markers are merged in alongside the MDI-derived glyphs.
Object.assign(icons, LITERAL);

const header = `// GENERATED by scripts/generate-bpmn-icons.mjs — do not edit by hand.
//
// A small, always-available icon pack (the \`bpmn\` package for \`icon:bpmn:<name>\`).
// The task-type glyphs (and the activity \`loop\` marker) are borrowed from Material
// Design Icons (Pictogrammers), licensed under Apache-2.0 — see licenses/mdi-APACHE-2.0.txt
// and THIRD-PARTY-NOTICES.md. The gateway markers (exclusive/inclusive/parallel/event/complex)
// and the multi-instance markers (mi-sequential/mi-parallel) are hand-drawn here (MIT).
// The \`manual\` glyph is rotated 90° clockwise. Regenerate with:
// node scripts/generate-bpmn-icons.mjs
import type { IconifyJSON } from '@iconify/types';

export const BPMN_PACK = 'bpmn';

export const bpmnIcons: IconifyJSON = `;

const body = JSON.stringify({ prefix: 'bpmn', width: 24, height: 24, icons }, null, 2);

writeFileSync(
  fileURLToPath(new URL('../src/bpmnIcons.ts', import.meta.url)),
  `${header}${body};\n`,
);
console.log(`Wrote src/bpmnIcons.ts with ${Object.keys(icons).length} icons.`);
