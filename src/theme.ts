import type { ThemeDefaults } from './styleModel.js';

// Bridges Mermaid's theme into the renderer. Mermaid hands each diagram a config
// getter through `injectUtils` (see diagram.ts); we stash it here so the
// renderer — which draws fills inline and therefore needs the palette in JS, not
// just CSS — can read the resolved theme variables at draw time.

type ConfigGetter = () => { themeVariables?: Record<string, unknown> } | undefined;

let getConfig: ConfigGetter | null = null;

export function setConfigGetter(fn: ConfigGetter): void {
  getConfig = fn;
}

// The renderer's palette: the entity styling fallbacks (ThemeDefaults) plus the
// default line color, which differs from the entity outline (Mermaid keeps
// `lineColor` separate from `nodeBorder`).
export interface RenderTheme extends ThemeDefaults {
  line: string;
  // The diagram background, used to fill "hollow" markers (a message flow's open
  // arrowhead and origin circle) so they read as background-with-outline.
  background: string;
}

// Reads the theme variables into the renderer's palette: the default node fill
// (`mainBkg`, then `primaryColor`), outline (`nodeBorder`, then
// `primaryBorderColor`), and line color (`lineColor`).
export function renderTheme(): RenderTheme {
  const vars = getConfig?.()?.themeVariables ?? {};
  const str = (key: string, fallback: string): string => {
    const v = vars[key];
    return typeof v === 'string' && v ? v : fallback;
  };
  return {
    fill: str('mainBkg', str('primaryColor', '#fff')),
    stroke: str('nodeBorder', str('primaryBorderColor', '#333')),
    line: str('lineColor', '#333'),
    background: str('background', '#ffffff'),
  };
}
