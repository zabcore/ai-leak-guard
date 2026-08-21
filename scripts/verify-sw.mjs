// Build-time guard: a MV3 service worker has no DOM, so any code reachable from
// the service-worker entry that references `window` or `document` will crash it
// at registration ("ReferenceError: window is not defined"). This walks the
// service worker's import graph in dist/ and fails if it finds either.
//
// It also catches the chunk-wiring class of bug where the SW loader accidentally
// imports the content-script bundle (which is full of window/document).
import { readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'

const DIST = 'dist'
// Match `document` / `window` used as an EXPRESSION — property
// access (`.foo`), subscript (`[…]`), assignment (`= …` but not
// `==`), or a function call (`(…)`). This is what actually crashes
// a MV3 service worker at runtime; a bare identifier appearing
// inside a string literal (e.g., a schema union like
// `t.eventType === 'document'`) is not real DOM access and must
// not false-positive.
//
// Design note (post-CR): an earlier revision stripped string /
// template literals BEFORE running a bare `\bdocument\b` scan.
// That approach modified the code before checking it and, on
// template literals with `${…}` interpolations, could have
// silently stripped an actual `document.foo` access inside
// `${…}`. Switching to executable-shape patterns avoids modifying
// the code at all — the check is "does the bundle contain an
// expression that reads/writes these globals", which is the
// runtime invariant we care about, and it's exactly what a JS
// engine sees. Bundlers virtually never leave `document` or
// `window` as bare identifiers in emitted code without a
// subsequent access, so the false-negative surface is negligible.
const FORBIDDEN = [
  { name: 'document', re: /\bdocument\s*(?:\.|\[|\()|\bdocument\s*=(?!=)/ },
  { name: 'window', re: /\bwindow\s*(?:\.|\[|\()|\bwindow\s*=(?!=)/ },
]
const IMPORT_RE = /(?:from\s*|import\s*\(?\s*|getURL\(\s*)['"]([^'"]+\.js)['"]/g

const manifest = JSON.parse(readFileSync(`${DIST}/manifest.json`, 'utf8'))
const swEntry = manifest.background?.service_worker
if (typeof swEntry !== 'string') {
  console.error('[verify-sw] No background.service_worker found in dist/manifest.json')
  process.exit(1)
}

const visited = new Set()
const queue = [resolve(DIST, swEntry)]

while (queue.length > 0) {
  const file = queue.shift()
  if (visited.has(file)) continue
  visited.add(file)

  let code
  try {
    code = readFileSync(file, 'utf8')
  } catch {
    console.error(`[verify-sw] Service-worker import not found on disk: ${relative('.', file)}`)
    process.exit(1)
  }

  for (const { name, re } of FORBIDDEN) {
    if (re.test(code)) {
      console.error(
        `[verify-sw] ${relative('.', file)} references \`${name}\`, which is undefined in an ` +
          `MV3 service worker. The service worker would fail to register. ` +
          `(Often caused by the SW entry being bundled with content-script code.)`,
      )
      process.exit(1)
    }
  }

  for (const match of code.matchAll(IMPORT_RE)) {
    const spec = match[1]
    // Relative imports (`./foo.js`, `../bar.js`) resolve against
    // the CURRENT chunk's directory — that's the only shape Vite
    // emits for cross-chunk imports. Root-relative shapes like
    // `/assets/foo.js` are worker-URL strings, resolved via
    // `chrome.runtime.getURL` at runtime, not JS imports; skip
    // them so the queue doesn't chase a bogus path.
    if (spec.startsWith('.')) {
      queue.push(resolve(dirname(file), spec))
    } else if (!spec.startsWith('/')) {
      queue.push(resolve(DIST, spec))
    }
  }
}

console.log(
  `[verify-sw] OK — ${visited.size} service-worker file(s) checked; no window/document references.`,
)
