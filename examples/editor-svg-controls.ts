import './editor-svg-controls.css';

type TControlActions = {
  zoom_out: () => void;
  reset: () => void;
  zoom_in: () => void;
};

export function createEditorSVGControls(actions: TControlActions) {
  const element = document.createElement('div');
  element.className = 'editor-svg-controls';
  const pill = document.createElement('div');
  pill.className = 'pill';
  pill.setAttribute('role', 'toolbar');
  pill.setAttribute('aria-label', 'Diagram navigation');
  const popover = createShortcutsPopover();
  let outsideListener: AbortController | null = null;

  const zoomOut = createIconButton('Zoom out', 'M5 12h14', actions.zoom_out);
  const zoomLabel = createButton('Reset zoom', 'Reset to 100%', actions.reset);
  zoomLabel.className = 'zoom-label';
  const zoomIn = createIconButton('Zoom in', 'M12 5v14M5 12h14', actions.zoom_in);
  const separator = document.createElement('span');
  separator.className = 'separator';
  separator.setAttribute('aria-hidden', 'true');
  const help = createIconButton(
    'Shortcuts',
    'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18zM9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6M12 17h.01',
    () => setHelpOpen(popover.hidden),
  );
  help.title = 'Keyboard and mouse shortcuts';
  help.setAttribute('aria-haspopup', 'dialog');
  help.setAttribute('aria-controls', popover.id);
  help.setAttribute('aria-expanded', 'false');
  pill.append(zoomOut, zoomLabel, zoomIn, separator, help);
  element.append(pill, popover);

  function setHelpOpen(open: boolean) {
    outsideListener?.abort();
    outsideListener = null;
    popover.hidden = !open;
    help.setAttribute('aria-expanded', String(open));
    if (!open) return;

    outsideListener = new AbortController();
    document.addEventListener('pointerdown', (event) => {
      if (!event.composedPath().includes(element)) setHelpOpen(false);
    }, { capture: true, signal: outsideListener.signal });
  }

  function setZoom(ratio: number) {
    const text = `${Math.round(ratio * 100)}%`;
    zoomLabel.textContent = text;
    zoomLabel.setAttribute('aria-label', `Zoom ${text}, reset to 100%`);
  }

  setZoom(1);
  return {
    element,
    setZoom,
    isHelpOpen: () => !popover.hidden,
    closeHelp: () => setHelpOpen(false),
  };
}

function createShortcutsPopover() {
  const element = document.createElement('div');
  element.className = 'popover';
  element.id = 'editor-svg-shortcuts';
  element.setAttribute('role', 'dialog');
  element.setAttribute('aria-label', 'Shortcuts');
  element.hidden = true;

  const heading = document.createElement('h2');
  heading.textContent = 'Shortcuts';
  const list = document.createElement('dl');
  const rows = [
    ['Pan', 'Drag'],
    ['Fit diagram', 'Esc'],
  ];
  for (const [action, gesture] of rows) {
    const term = document.createElement('dt');
    term.textContent = action;
    const detail = document.createElement('dd');
    detail.textContent = gesture;
    list.append(term, detail);
  }
  element.append(heading, list);
  return element;
}

function createButton(label: string, title: string, onClick: () => void) {
  const button = document.createElement('button');
  button.type = 'button';
  button.setAttribute('aria-label', label);
  button.title = title;
  button.addEventListener('click', onClick);
  return button;
}

function createIconButton(label: string, pathData: string, onClick: () => void) {
  const button = createButton(label, label, onClick);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', pathData);
  svg.append(path);
  button.append(svg);
  return button;
}
