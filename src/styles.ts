// Mermaid injects this into a <style> scoped to the diagram's svg, calling it
// with the resolved theme variables (plus `svgId`). We read the palette from
// them so an unstyled diagram tracks the active Mermaid theme (including dark
// mode), falling back to sensible defaults when a variable is missing.
//
// These are the *defaults*: every drawn entity outline carries `bpmn-entity`
// (plus `bpmn-<type>` and, for containers, `bpmn-container`), and every edge
// `bpmn-edge`. The renderer overrides fill — and stroke, when a `style` applies —
// with an inline `style`, which beats these rules; so `fill` is intentionally NOT
// set here.

interface ThemeOptions {
  nodeBorder?: string;
  primaryBorderColor?: string;
  lineColor?: string;
  textColor?: string;
  nodeTextColor?: string;
  fontFamily?: string;
  fontSize?: string | number;
}

const pick = (value: string | number | undefined, fallback: string): string =>
  value !== undefined && value !== '' ? String(value) : fallback;

// The error diagnostic is a fixed bold red by design: it must stand out regardless
// of the active theme, so it is not theme-derived.
const ERROR_RED = '#ff0000';

const styles = (options: ThemeOptions = {}): string => {
  const stroke = pick(options.nodeBorder ?? options.primaryBorderColor, '#333');
  const line = pick(options.lineColor, '#333');
  const text = pick(options.nodeTextColor ?? options.textColor, '#333');
  const font = pick(options.fontFamily, "'trebuchet ms', verdana, arial, sans-serif");
  const fontSize = pick(options.fontSize, '14px');
  return `
  .bpmn-entity {
    stroke: ${stroke};
    stroke-width: 1.5px;
  }
  /* A group is a visible grouping box: a dash-dot border (BPMN's group notation)
     with round corners (set as rect rx/ry in the renderer). Its interior stays
     transparent so it never obscures the entities it wraps. */
  .bpmn-group {
    stroke-dasharray: 8 3 2 3;
  }
  /* A diagnostic node (an unparseable line, or an unresolved line endpoint) is
     drawn with an extra-bold red border so it stands out. It comes after the base
     \`.bpmn-entity\` rule so its equal-specificity stroke wins. */
  .bpmn-error {
    stroke: ${ERROR_RED};
    stroke-width: 3px;
  }
  /* Every caption: on a node (\`bpmn-label\`) or along a connection
     (\`bpmn-line-label\`). The two share one rule because a line caption is measured
     in the class it is drawn with — giving them different metrics would make the
     box ELK reserves disagree with the text that lands in it. */
  .bpmn-label,
  .bpmn-line-label {
    fill: ${text};
    font-family: ${font};
    font-size: ${fontSize};
  }
  /* Icons inherit the label text color through \`currentColor\` in their body, so
     monochrome packs (e.g. Lucide) match the caption; multicolor packs keep their
     own fills. */
  .bpmn-icon {
    color: ${text};
  }
  /* Connections between entities. */
  .bpmn-edge {
    fill: none;
    stroke: ${line};
    stroke-width: 1.5px;
  }
  .bpmn-arrow {
    fill: ${line};
  }
  /* A line-end slash tick (a leading/trailing \`/\` connector — BPMN's
     default-sequence-flow marker). Drawn as its own short line, so it tracks the
     edge color; an explicit line stroke overrides it inline (see renderer). */
  .bpmn-edge-slash {
    stroke: ${line};
    stroke-width: 1.5px;
  }
  /* A message flow (a connection crossing pool boundaries) is dashed. Its hollow
     arrowhead and origin circle are drawn as inline-styled markers (see renderer). */
  .bpmn-message-flow {
    stroke-dasharray: 6 4;
  }
  /* A data association (a connection touching a data element) is dotted. Its open
     "V" arrowhead is drawn as an inline-styled marker (see renderer). */
  .bpmn-data-assoc {
    stroke-dasharray: 2 4;
  }
`;
};

export default styles;
