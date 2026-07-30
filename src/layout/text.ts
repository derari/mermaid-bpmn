// Caption measuring and drawing helpers, shared by the agnostic edge renderer and
// by node drawing. Diagram-agnostic: callers pass the CSS class and line height to
// use, so the visual style is not baked in. The `bpmn-label` probe class and the
// default line height below are only fallbacks a style may override.
import { svgEl } from './svg.js';

// Default caption line height (px). A style may pass its own to captionText/Height;
// the browser's real metrics differ slightly, this is the layout approximation.
export const LABEL_LINE_H = 18;

export type Measure = (text: string, className?: string) => number;

// Measures rendered label width using a throwaway <text> in the target svg, so
// box sizing matches the actual font/metrics the browser will use. The caller
// must invoke the returned `done()` to remove the probe once measuring is over.
// `probeClass` is the CSS class the probe wears, so metrics match the drawn text.
export function makeMeasurer(
  svg: SVGSVGElement,
  probeClass = 'bpmn-label',
): { measure: Measure; done: () => void } {
  const probe = svgEl('text', { class: probeClass, x: -9999, y: -9999 });
  svg.appendChild(probe);
  return {
    // `className` lets a caller measure with a variant label style (a smaller
    // font) so its box sizes to the text as actually drawn.
    measure(text: string, className = probeClass) {
      probe.setAttribute('class', className);
      probe.textContent = text;
      return probe.getComputedTextLength();
    },
    done() {
      probe.remove();
    },
  };
}

// A caption may be multiple lines (a `\n` or `|` block label). These helpers keep
// callers from re-splitting it everywhere.
// The caption's lines. A single-line caption is a one-element array.
export function captionLines(caption: string): string[] {
  return caption.split('\n');
}
// The width the box must reserve: the widest line, in the caption's own font.
export function measureCaption(caption: string, measure: Measure, className?: string): number {
  let width = 0;
  for (const line of captionLines(caption)) width = Math.max(width, measure(line, className));
  return width;
}
// The height a caption occupies: one `lineH` per line (a single line is just `lineH`).
export function captionHeight(caption: string, lineH: number = LABEL_LINE_H): number {
  return captionLines(caption).length * lineH;
}

// A caption drawn on (`x`, `cy`), one <tspan> per line for a multi-line label so it
// reads as stacked, vertically centred rows. A single line stays a plain <text>
// (its `dominant-baseline: central` centres it), so nothing about the common case
// changes. `cy` defaults to 0 for callers that centre the whole group with their
// own transform. `anchor` is the horizontal alignment about `x` (default `middle`);
// a line-label fallback passes `start` to sit the caption to one side of the line.
export function captionText(
  caption: string,
  x: number,
  className: string,
  lineH: number,
  cy = 0,
  anchor = 'middle',
): SVGTextElement {
  const text = svgEl('text', {
    x,
    y: cy,
    'text-anchor': anchor,
    'dominant-baseline': 'central',
    class: className,
  });
  const lines = captionLines(caption);
  if (lines.length === 1) {
    text.textContent = caption;
    return text;
  }
  // Centre the block on `cy`: the first line sits half the block's height above it.
  // Each tspan carries its own absolute y, so it holds regardless of the parent's.
  const y0 = cy - ((lines.length - 1) / 2) * lineH;
  lines.forEach((line, i) => {
    const tspan = svgEl('tspan', { x, y: y0 + i * lineH });
    tspan.textContent = line;
    text.appendChild(tspan);
  });
  return text;
}
