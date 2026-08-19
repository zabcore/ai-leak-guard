// Lazy-load bundle discipline.
//
// The extraction layer promises that heavy parsers (`pdfjs-dist`,
// `xlsx`, `jszip`) are loaded ONLY when the flag is on AND a
// matching file is being inspected. The mechanism is dynamic
// `import()` from `extract.ts` — anything reachable statically from
// `src/content/index.ts` must NOT include these deps.
//
// A test that inspects bundler output is brittle across bundler
// versions, so we assert the source-level guarantee instead: the
// files that live on the main content-script path must not use
// top-level `import ... from 'pdfjs-dist'` (or 'xlsx' / 'jszip').
// Dynamic `import(...)` is fine — that's what we want the extractor
// to do.

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')

const HEAVY_DEPS = ['pdfjs-dist', 'xlsx', 'jszip'] as const

// Files that MUST stay lightweight (main content-script path +
// extractor entry point + inspector). Format-module files
// (formats/*.ts) are allowed to statically import heavy deps —
// they're only reachable via dynamic import().
const LIGHT_PATH_FILES = [
  'src/content/index.ts',
  'src/content/document-flow.ts',
  'src/content/file-inspector.ts',
  'src/content/extraction/extract.ts',
]

// Regex for a top-level `import ... from 'foo'` or bare
// `import 'foo'` — dynamic `import(...)` is NOT matched because we
// require the module path to end with a matching quote AND be at
// the start of a line (top-level).
function topLevelImportRegex(dep: string): RegExp {
  const escaped = dep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(
    `^\\s*import\\b[^\\n]*from\\s+['"]${escaped}['"]|^\\s*import\\s+['"]${escaped}['"]`,
    'm',
  )
}

describe('extraction lazy-load discipline', () => {
  for (const relPath of LIGHT_PATH_FILES) {
    for (const dep of HEAVY_DEPS) {
      it(`${relPath} does NOT statically import ${dep}`, async () => {
        const src = await readFile(resolve(ROOT, relPath), 'utf8')
        const re = topLevelImportRegex(dep)
        expect(re.test(src)).toBe(false)
      })
    }
  }

  it('extract.ts dynamically imports the format modules (not static)', async () => {
    const src = await readFile(resolve(ROOT, 'src/content/extraction/extract.ts'), 'utf8')
    // Every format import should be an `await import('./formats/…')` form.
    expect(src).toMatch(/await import\(['"]\.\/formats\/pdf['"]\)/)
    expect(src).toMatch(/await import\(['"]\.\/formats\/xlsx['"]\)/)
    expect(src).toMatch(/await import\(['"]\.\/formats\/docx['"]\)/)
    expect(src).toMatch(/await import\(['"]\.\/formats\/pptx['"]\)/)
    expect(src).toMatch(/await import\(['"]\.\/formats\/text['"]\)/)
    // And no top-level static form of them.
    expect(src).not.toMatch(/^\s*import[^\n]*from\s*['"]\.\/formats\/pdf['"]/m)
  })
})
