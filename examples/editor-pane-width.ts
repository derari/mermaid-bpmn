import { readEditorState, writeEditorState } from './editor-state';

const DEFAULT_SOURCE_PANE_WIDTH = '30%';
const SOURCE_PANE_WIDTHS = ['30%', '50%'];

export function initializeEditorPaneWidth(main: HTMLElement, controls: Iterable<HTMLButtonElement>) {
  const paneWidthControls = Array.from(controls);

  function setSourcePaneWidth(width: string) {
    main.style.setProperty('--source-pane-width', width);

    for (const control of paneWidthControls) {
      control.setAttribute('aria-pressed', String(control.dataset.sourcePaneWidth === width));
    }
    writeEditorState('source-pane-width', width);
  }

  for (const control of paneWidthControls) {
    control.addEventListener('click', () => setSourcePaneWidth(control.dataset.sourcePaneWidth ?? DEFAULT_SOURCE_PANE_WIDTH));
  }

  const savedWidth = readEditorState('source-pane-width');
  const initialWidth = savedWidth !== null && SOURCE_PANE_WIDTHS.includes(savedWidth) ? savedWidth : DEFAULT_SOURCE_PANE_WIDTH;
  setSourcePaneWidth(initialWidth);
}
