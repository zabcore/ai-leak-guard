// V1.2 A2 PDF text-layer extractor.
//
// pdf.js reads the PDF's TEXT LAYER — the actual character-content
// stream. A scanned PDF (an image wrapped in a PDF envelope) has no
// text layer; A2 gate B is settled — NO OCR. That case is reported
// as `no-text-layer`, distinct from a parse failure.
//
// Security posture (mirrored in `docs/ARCHITECTURE.md`):
//   • `isEvalSupported: false` — refuse to `eval` anything from the
//     PDF (font programs, JS actions). pdf.js still parses without
//     eval, just a hair slower for some fonts.
//   • `disableFontFace: true` + `useSystemFonts: false` — never load
//     a system or web font. We only need character codes, not glyphs.
//   • The worker script is bundled locally via `?worker` — no CDN
//     `workerSrc`. A no-network test asserts this.
//
// The worker is lazily instantiated on first use (matches the parent
// module's dynamic import strategy). This avoids spawning a Worker
// during unit tests that don't exercise the PDF path.

import type { FormatOutput } from '../extract'
import { EXTRACTOR_ERROR_ENCRYPTED, EXTRACTOR_ERROR_NO_TEXT_LAYER } from '../extract'

// Injectable pdf.js loader — production path uses the real
// `pdfjs-dist`; tests can `vi.mock('./pdf')` to replace the module or
// override this seam without spawning a real Worker in jsdom.
export type PdfjsModule = typeof import('pdfjs-dist')

let cachedPdfjs: PdfjsModule | null = null

async function loadPdfjs(): Promise<PdfjsModule> {
  if (cachedPdfjs !== null) return cachedPdfjs
  const mod = (await import('pdfjs-dist')) as PdfjsModule
  await ensureWorkerConfigured(mod)
  cachedPdfjs = mod
  return mod
}

async function ensureWorkerConfigured(mod: PdfjsModule): Promise<void> {
  const opts = (
    mod as unknown as { GlobalWorkerOptions?: { workerPort?: unknown; workerSrc?: string } }
  ).GlobalWorkerOptions
  if (!opts) return
  if (opts.workerPort || opts.workerSrc) return
  // Import the worker with Vite's `?worker` suffix; the bundler emits
  // it as a separate chunk and returns a `Worker` constructor. This
  // ships the worker script alongside the extension — nothing is
  // fetched over the network at runtime.
  const workerCtor = (await import('pdfjs-dist/build/pdf.worker.mjs?worker'))
    .default as unknown as new () => Worker
  opts.workerPort = new workerCtor()
}

export async function extractPdf(file: File): Promise<FormatOutput> {
  const pdfjs = await loadPdfjs()
  const data = new Uint8Array(await file.arrayBuffer())
  // Options object typed loosely because `isEvalSupported` isn't in
  // the shipped .d.ts across all pdf.js releases even though the
  // runtime honours it. Using a typed cast keeps the intent
  // explicit — every option here is a security posture, not a
  // performance knob.
  const getDocument = (
    pdfjs as unknown as { getDocument: (opts: unknown) => { promise: Promise<PdfDocument> } }
  ).getDocument
  const loadingTask = getDocument({
    data,
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    disableAutoFetch: true,
    disableStream: true,
  })
  let doc: PdfDocument
  try {
    doc = await loadingTask.promise
  } catch (err) {
    // pdf.js throws `PasswordException` when the file is
    // encrypted. Detect by the `name` field (or the string form)
    // rather than by `instanceof`, since the class isn't always
    // preserved across worker boundaries.
    if (isPasswordException(err)) {
      throw new Error(EXTRACTOR_ERROR_ENCRYPTED)
    }
    throw err
  }
  try {
    const parts: string[] = []
    const pageCount = doc.numPages
    for (let i = 1; i <= pageCount; i++) {
      const page = await doc.getPage(i)
      const content = await page.getTextContent()
      const line = content.items
        .map((it) =>
          typeof (it as { str?: string }).str === 'string' ? (it as { str: string }).str : '',
        )
        .join(' ')
      parts.push(line)
      // Release the page's rendering resources.
      page.cleanup?.()
    }
    const text = parts.join('\n')
    if (text.trim().length === 0) {
      // Cleanly-parsed but no text layer — the classic scanned PDF
      // case. Report as `no-text-layer`, not `empty`, so A4 can
      // surface "we couldn't read this file" rather than "we read it
      // and it was empty".
      throw new Error(EXTRACTOR_ERROR_NO_TEXT_LAYER)
    }
    return { kind: 'text', text }
  } finally {
    try {
      await doc.destroy()
    } catch {
      // Ignore destroy errors — the underlying resources drop on GC.
    }
  }
}

// Minimal pdf.js document shape used by this module. Kept local so
// we don't take a hard dep on pdf.js's exported types (which have
// been shuffled across versions).
interface PdfDocument {
  readonly numPages: number
  getPage(n: number): Promise<PdfPage>
  destroy(): Promise<void>
}
interface PdfPage {
  getTextContent(): Promise<{ items: readonly unknown[] }>
  cleanup?: () => void
}

function isPasswordException(err: unknown): boolean {
  if (err instanceof Error) {
    if (err.name === 'PasswordException') return true
    if (/password/i.test(err.message)) return true
  }
  const rec = err as { name?: unknown } | null
  if (rec && typeof rec.name === 'string' && rec.name === 'PasswordException') return true
  return false
}
