import type { ExternalDiagramDefinition } from 'mermaid';
import { db } from './db.js';

// Mermaid doesn't re-export `DiagramDefinition` from its package root — only
// `ExternalDiagramDefinition` is public — so derive it from the loader's resolved
// shape ({ id, diagram }) rather than reaching into an internal deep import.
type DiagramDefinition = Awaited<ReturnType<ExternalDiagramDefinition['loader']>>['diagram'];
import { parser } from './parser.js';
import { renderer } from './renderer.js';
import styles from './styles.js';
import { setConfigGetter } from './theme.js';

export const diagram: DiagramDefinition = {
  db,
  parser,
  renderer,
  styles,
  // Mermaid passes the resolved-config getter here; the renderer needs it to
  // read theme colors (fills are drawn inline, so CSS alone can't supply them).
  injectUtils(
    _log: unknown,
    _setLogLevel: unknown,
    getConfig: () => { themeVariables?: Record<string, unknown> },
  ) {
    setConfigGetter(getConfig);
  },
};
