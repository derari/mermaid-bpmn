import type { ExternalDiagramDefinition } from 'mermaid';

const id = 'bpmn';

// Claims any text whose first non-blank content starts with `bpmn`.
const detector = (txt: string): boolean => /^\s*bpmn/.test(txt);

// Lazily loads the diagram implementation only when a bpmn diagram is found,
// so consumers who never use bpmn don't pay for it.
const loader = async () => {
  const { diagram } = await import('./diagram.js');
  return { id, diagram };
};

export const bpmn: ExternalDiagramDefinition = { id, detector, loader };

// Icon support: register Iconify packs the `icon:` style prop can draw from.
// Re-exported from the entry so consumers `import { registerIconPacks } from
// 'mermaid-bpmn'`. It carries no heavy dependency itself — `@iconify/utils` is
// pulled in lazily only when a diagram actually resolves an icon (see icons.ts).
export { registerIconPacks, type IconPack } from './icons.js';

// The layouted BPMN 2.0 document behind the last render, for a host page that
// wants to offer it as a download. Only `layout auto` produces one.
export { getLastBpmnXml } from './lastBpmn.js';

export default bpmn;
