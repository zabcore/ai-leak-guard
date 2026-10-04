import { defineConfig, loadEnv } from 'vite'
import { crx } from '@crxjs/vite-plugin'
import manifest from './manifest.json'

// Teams Lite (#78): the committed manifest already grants the local
// `supabase functions serve` origins for the dev demo. When a build configures a
// real backend via `VITE_TEAMS_BASE_URL`, add THAT origin too so the enrolled
// check-in fetch is permitted there. An unconfigured (Free) build adds nothing.
// The host permission alone is inert — the enrollment client (the only `fetch`)
// is loaded lazily and only after an explicit enroll, so the free path is silent.
function manifestWithBackendHost(baseUrl: string): typeof manifest {
  const trimmed = baseUrl.trim()
  if (trimmed === '') return manifest
  let origin: string
  try {
    origin = `${new URL(trimmed).origin}/*`
  } catch {
    return manifest
  }
  const hosts = new Set<string>(manifest.host_permissions ?? [])
  hosts.add(origin)
  return { ...manifest, host_permissions: [...hosts] }
}

// Teams Lite (#78): the enrollment client is loaded via a dynamic `import()`
// (so it is its own chunk and the free path never loads it). Vite wraps every
// dynamic import with its `__vitePreload` helper, which calls
// `document.createElement` / `window.dispatchEvent`. In the MV3 SERVICE WORKER
// (which check-ins run from) there is no DOM, so that helper would trip
// `verify:sw` and could ReferenceError. We already disable module preloading
// (`build.modulePreload: false`), so the helper's only job — preloading link
// tags — is moot; replace it everywhere with a DOM-free passthrough that just
// runs the import. Safe in every context (popup/content still work; nothing
// relies on `vite:preloadError`).
function passthroughPreloadHelper(): import('vite').Plugin {
  return {
    name: 'alg-passthrough-preload-helper',
    enforce: 'pre',
    load(id) {
      if (id.includes('vite/preload-helper')) {
        return 'export function __vitePreload(baseModule){return baseModule()}'
      }
      return null
    },
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_')
  const mergedManifest = manifestWithBackendHost(env.VITE_TEAMS_BASE_URL ?? '')
  return {
    plugins: [passthroughPreloadHelper(), crx({ manifest: mergedManifest })],
    build: {
      // Chrome extensions reject cross-world <link rel="modulepreload"> tags with
      // "cross-world extension resource mismatch" errors on chrome://extensions.
      // Disabling both the injection and the polyfill keeps the popup HTML clean.
      modulePreload: false,
      rollupOptions: {
        output: {
          // Teams Lite (#78): the service worker STATICALLY imports the check-in
          // client (dynamic import() is disallowed in a worker). Pin two modules
          // to their own chunks so rollup can't park the pure, shared
          // `teams-contract` inside a window-using content chunk (pdf/zip) and
          // drag it into the worker's import graph (which breaks SW registration):
          //  - `teams-client`: the ONLY fetch; kept as its own chunk so the
          //    `verify:no-network` allowlist still matches by name, the worker can
          //    import it statically, and the popup/content still load it lazily.
          //  - `teams-contract`: pure (no imports); isolated so it never merges
          //    into a DOM chunk.
          // Both are DOM-free (fetch / plain data only); `verify:sw` enforces it.
          manualChunks(id: string) {
            if (/\/src\/enterprise\/teams-client\./.test(id)) return 'teams-client'
            if (/\/src\/shared\/teams-contract\./.test(id)) return 'teams-contract'
            return undefined
          },
        },
      },
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
  }
})
