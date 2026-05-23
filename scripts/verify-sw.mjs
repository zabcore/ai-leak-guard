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
const FORBIDDEN = ['window', 'document']
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

  for (const token of FORBIDDEN) {
    if (new RegExp(`\\b${token}\\b`).test(code)) {
      console.error(
        `[verify-sw] ${relative('.', file)} references \`${token}\`, which is undefined in an ` +
          `MV3 service worker. The service worker would fail to register. ` +
          `(Often caused by the SW entry being bundled with content-script code.)`,
      )
      process.exit(1)
    }
  }

  for (const match of code.matchAll(IMPORT_RE)) {
    const spec = match[1]
    queue.push(resolve(dirname(file), spec), resolve(DIST, spec))
  }
}

console.log(
  `[verify-sw] OK — ${visited.size} service-worker file(s) checked; no window/document references.`,
)
