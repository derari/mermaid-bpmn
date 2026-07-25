import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// Serves the examples in `examples/`. In dev the pages import the library
// straight from `src/` (TypeScript), so a refresh picks up source changes with
// no rebuild. `vite build` bundles them into `site/` for GitHub Pages.
export default defineConfig(({ mode }) => ({
  root: 'examples',
  // Project Pages are hosted under /<repo>/; dev is served from the root.
  // `mode` (not `command`) so `vite preview` — which runs in production mode —
  // matches the base baked into the build.
  base: mode === 'production' ? '/mermaid-bpmn/' : '/',
  server: {
    // The examples import `../src/index.ts`, which lives outside the Vite root.
    fs: { allow: ['..'] },
  },
  build: {
    outDir: fileURLToPath(new URL('./site', import.meta.url)),
    emptyOutDir: true,
    // The example pages use top-level await; target a modern baseline that allows it.
    target: 'esnext',
    rollupOptions: {
      input: {
        index: fileURLToPath(new URL('./examples/index.html', import.meta.url)),
        editor: fileURLToPath(new URL('./examples/editor.html', import.meta.url)),
      },
    },
  },
}));
