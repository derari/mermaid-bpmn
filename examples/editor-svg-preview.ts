import { createEditorSVGNavigation } from './editor-svg-navigation';
import { createEditorSVGControls } from './editor-svg-controls';

type TSVGSnapshot = {
  svg: SVGSVGElement;
  width: number;
  height: number;
};

export function createEditorSVGPreview(output: HTMLElement) {
  const navigation = createEditorSVGNavigation(output, (ratio) => controls.setZoom(ratio));
  const controls = createEditorSVGControls({
    zoom_out: navigation.zoomOut,
    reset: navigation.reset,
    zoom_in: navigation.zoomIn,
  });
  let snapshot: TSVGSnapshot | null = null;

  function show(markup: string) {
    clear();
    output.innerHTML = markup;
    const svg = output.querySelector('svg');
    if (!svg) return;

    // Capture the diagram before navigation changes its attributes or children.
    const cleanSVG = svg.cloneNode(true) as SVGSVGElement;
    const vb = svg.viewBox.baseVal;
    let width: number;
    let height: number;
    if (vb.width && vb.height) {
      width = vb.width;
      height = vb.height;
    } else {
      const rect = svg.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
    }
    snapshot = { svg: cleanSVG, width, height };

    // Size only the live viewport; exports retain Mermaid's original sizing.
    svg.style.width = '100%';
    svg.style.height = '100%';
    svg.style.maxWidth = 'none';
    navigation.attach(svg);
    output.append(controls.element);
  }

  function clear() {
    controls.closeHelp();
    navigation.detach();
    snapshot = null;
    output.replaceChildren();
  }

  function handleEscape() {
    if (controls.isHelpOpen()) {
      controls.closeHelp();
    } else {
      navigation.fit();
    }
  }

  // All export paths use the clean snapshot, with intrinsic dimensions when
  // available and the original rendered dimensions as a fallback.
  function serialize(dims: Record<string, number>) {
    if (!snapshot) return null;

    const { svg, width, height } = snapshot;
    const clone = svg.cloneNode(true) as SVGSVGElement;
    clone.setAttribute('width', String(width));
    clone.setAttribute('height', String(height));
    clone.style.maxWidth = '';
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');

    dims.width = width;
    dims.height = height;
    return new XMLSerializer().serializeToString(clone);
  }

  return { show, clear, serialize, fit: navigation.fit, handleEscape };
}
