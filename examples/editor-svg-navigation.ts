import svgPanZoom from 'svg-pan-zoom';

export function createEditorSVGNavigation(pane: HTMLElement, onZoomChange: (ratio: number) => void) {
  let svg: SVGSVGElement | null = null;
  let instance: ReturnType<typeof svgPanZoom> | null = null;
  const observer = new ResizeObserver(refresh);

  function hasUsableSize() {
    if (!svg) return false;

    const style = getComputedStyle(pane);
    const width = pane.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const height = pane.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
    const rect = svg.getBoundingClientRect();
    return width > 0 && height > 0 && rect.width > 0 && rect.height > 0;
  }

  function initialize() {
    if (!svg || !hasUsableSize()) return;

    instance = svgPanZoom(svg, {
      controlIconsEnabled: false,
      fit: true,
      center: true,
    });
    instance.setOnZoom(updateZoom);
    updateZoom();
  }

  function attach(element: SVGSVGElement) {
    detach();
    svg = element;
    observer.observe(pane);
    initialize();
  }

  function fit() {
    if (!hasUsableSize()) return;
    if (!instance) initialize();
    if (!instance) return;

    instance.resize();
    instance.fit();
    instance.center();
    updateZoom();
  }

  function refresh() {
    if (!hasUsableSize()) return;
    if (!instance) {
      initialize();
      return;
    }

    // Refresh geometry and control positions without changing the user's view.
    instance.resize();
    updateZoom();
  }

  function zoomIn() {
    instance?.zoomIn();
  }

  function zoomOut() {
    instance?.zoomOut();
  }

  function reset() {
    instance?.reset();
  }

  function updateZoom() {
    onZoomChange(instance?.getZoom() ?? 1);
  }

  function detach() {
    observer.disconnect();
    instance?.destroy();
    instance = null;
    svg = null;
  }

  return { attach, fit, refresh, detach, zoomIn, zoomOut, reset };
}
