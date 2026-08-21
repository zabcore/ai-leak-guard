import { defineConfig } from 'vite'
import { crx } from '@crxjs/vite-plugin'
import manifest from './manifest.json'

export default defineConfig({
  plugins: [crx({ manifest })],
  build: {
    // Chrome extensions reject cross-world <link rel="modulepreload"> tags with
    // "cross-world extension resource mismatch" errors on chrome://extensions.
    // Disabling both the injection and the polyfill keeps the popup HTML clean.
    modulePreload: false,
  },
  // V1.2 A4.3 (#39): our local workers (xlsx.worker.ts) are spawned
  // from a `blob:` URL in `spawnExtensionWorkerFromBlob`, so they
  // MUST be self-contained — a blob module worker can't resolve a
  // relative `./chunk-hash.js` import against its own origin. IIFE
  // format + inlined dynamic imports forces the whole worker (and
  // its deps, e.g. SheetJS) into a single self-contained chunk;
  // xlsx.ts then spawns it as a CLASSIC worker (no `{type:'module'}`).
  // pdf.js's worker is a pre-built self-contained .mjs imported via
  // `?url` (not `?worker`) — this config doesn't touch it, and its
  // blob module-worker path remains intact.
  worker: {
    format: 'iife',
    rollupOptions: {
      output: { inlineDynamicImports: true },
    },
  },
})
