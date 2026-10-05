const OPEN_SVG_CACHE_NAME = 'mermaid-bpmn-open-svg';

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const scope = new URL(self.registration.scope);
  const svgPathPrefix = `${scope.pathname}svg/`;

  if (
    event.request.method !== 'GET' ||
    !url.pathname.startsWith(svgPathPrefix) ||
    !url.pathname.endsWith('.svg')
  ) {
    return;
  }

  event.respondWith(
    caches.open(OPEN_SVG_CACHE_NAME).then(async (cache) => {
      const response = await cache.match(event.request);

      return (
        response ||
        new Response('SVG document not found.', {
          status: 404,
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        })
      );
    }),
  );
});
