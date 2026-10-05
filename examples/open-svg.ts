const OPEN_SVG_CACHE_NAME = 'mermaid-bpmn-open-svg';

const openSvgWorkerReady = registerOpenSvgWorker();

export function createOpenSvgClickHandler(
  serializeSvg: (dims: Record<string, number>) => string | null,
  output: HTMLElement,
) {
  return async function handleOpenSvgClick() {
    try {
      await openSvgInNewTab(serializeSvg({}));
    } catch (error) {
      output.innerHTML = `<div class="error">Could not open the SVG in a separate tab: ${String(error)}</div>`;
    }
  };
}

export async function openSvgInNewTab(markup: string | null) {
  if (!markup || !openSvgWorkerReady) return;

  const tab = window.open('', '_blank');
  if (!tab) return;

  try {
    await openSvgWorkerReady;

    const url = new URL(`svg/${crypto.randomUUID()}.svg`, window.location.href);
    const cache = await caches.open(OPEN_SVG_CACHE_NAME);

    await cache.put(
      url,
      new Response(markup, {
        headers: { 'Content-Type': 'image/svg+xml;charset=utf-8' },
      }),
    );

    tab.location.assign(url);
  } catch (error) {
    tab.close();
    throw error;
  }
}

function registerOpenSvgWorker() {
  if (!('serviceWorker' in navigator)) return null;

  return navigator.serviceWorker
    .register(`${import.meta.env.BASE_URL}open-svg.service-worker.js`)
    .then(() => navigator.serviceWorker.ready);
}
