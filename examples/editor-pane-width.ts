const DEFAULT_SOURCE_PANE_WIDTH = '30%';

export function initializeEditorPaneWidth(main: HTMLElement, controls: Iterable<HTMLButtonElement>) {
  const paneWidthControls = Array.from(controls);

  function setSourcePaneWidth(width: string) {
    main.style.setProperty('--source-pane-width', width);

    for (const control of paneWidthControls) {
      control.setAttribute('aria-pressed', String(control.dataset.sourcePaneWidth === width));
    }
  }

  for (const control of paneWidthControls) {
    control.addEventListener('click', () => setSourcePaneWidth(control.dataset.sourcePaneWidth ?? DEFAULT_SOURCE_PANE_WIDTH));
  }

  setSourcePaneWidth(DEFAULT_SOURCE_PANE_WIDTH);
}
