// V1.2 A2 PDF text-layer extractor.
//
// pdf.js reads the PDF's TEXT LAYER — the actual character-content
// stream. A scanned PDF (an image wrapped in a PDF envelope) has no
// text layer; A2 gate B is settled — NO OCR. That case is reported
// as `no-text-layer`, distinct from a parse failure.
//
// Security posture (mirrored in `docs/ARCHITECTURE.md`):
//   • `disableFontFace: true` + `useSystemFonts: false` — never
//     load a system or web font. We only need character codes, not
//     glyphs.
//   • `disableAutoFetch: true` + `disableStream: true` — pdf.js
//     doesn't reach out for anything (asserted by the no-network
//     test).
//   • The worker script is bundled locally via `?worker` — no CDN
//     `workerSrc`. Reviewed pdf.js 6.2 no longer honours the
//     `isEvalSupported` option and its build contains no dynamic
//     evaluation, so we don't set that flag.
//
// The worker is lazily instantiated on first use (matches the parent
// module's dynamic import strategy). We cache the IN-FLIGHT
// initialisation promise (not the resolved module) so two concurrent
// PDF extractions share one worker — caching the resolved module
// alone raced and would spawn (and then leak) a duplicate Worker.
//
// On timeout: extract.ts calls `abortActivePdfLoads()` (via an
// AbortSignal) so pdf.js releases the loading task and its worker
// stops parsing the offending file.

import type { FormatOutput } from '../extract'
import { EXTRACTOR_ERROR_ENCRYPTED, EXTRACTOR_ERROR_NO_TEXT_LAYER } from '../extract'

// Injectable pdf.js loader — production path uses the real
// `pdfjs-dist`; tests can `vi.mock('pdfjs-dist')` to replace the
// module without spawning a real Worker in jsdom.
export type PdfjsModule = typeof import('pdfjs-dist')

// Cache the in-flight initialisation promise, not the resolved
// module. Two concurrent `loadPdfjs` calls therefore await the same
// promise; without this both would independently `await import(...)`
// and both would enter `ensureWorkerConfigured` before either
// assigned the cache, spawning (and leaking) a duplicate Worker.
let pdfjsPromise: Promise<PdfjsModule> | null = null

async function loadPdfjs(): Promise<PdfjsModule> {
  if (pdfjsPromise !== null) return pdfjsPromise
  pdfjsPromise = (async (): Promise<PdfjsModule> => {
    const mod = (await import('pdfjs-dist')) as PdfjsModule
    await ensureWorkerConfigured(mod)
    return mod
  })().catch((err) => {
    // On failure, drop the cached promise so a subsequent call gets
    // a fresh attempt (matches the fail-open retry posture the FSA
    // hook uses for its handshake).
    pdfjsPromise = null
    throw err
  })
  return pdfjsPromise
}

async function ensureWorkerConfigured(mod: PdfjsModule): Promise<void> {
  const opts = (
    mod as unknown as { GlobalWorkerOptions?: { workerPort?: unknown; workerSrc?: string } }
  ).GlobalWorkerOptions
  if (!opts) return
  if (opts.workerPort || opts.workerSrc) return
  // Import the worker with Vite's `?worker` suffix; the bundler
  // emits it as a separate chunk and returns a `Worker` constructor.
  // Ships alongside the extension — no runtime network.
  const workerCtor = (await import('pdfjs-dist/build/pdf.worker.mjs?worker'))
    .default as unknown as new () => Worker
  opts.workerPort = new workerCtor()
}

/**
 * Options seam for the caller: an `AbortSignal` from the extraction
 * timeout so the pdf.js loading task and page work can be released
 * as soon as the deadline hits (instead of continuing to burn
 * worker time in the background).
 */
export interface ExtractPdfOptions {
  readonly signal?: AbortSignal
}

export async function extractPdf(file: File, opts: ExtractPdfOptions = {}): Promise<FormatOutput> {
  const pdfjs = await loadPdfjs()
  const data = new Uint8Array(await file.arrayBuffer())
  const getDocument = (pdfjs as unknown as { getDocument: (opts: unknown) => PdfLoadingTask })
    .getDocument
  const loadingTask = getDocument({
    data,
    disableFontFace: true,
    useSystemFonts: false,
    disableAutoFetch: true,
    disableStream: true,
  })
  // Wire the caller's signal to pdf.js's own cancel primitive. This
  // is the difference between a "we returned; worker keeps parsing"
  // orphan and a truly cancelled load.
  let onAbort: (() => void) | null = null
  if (opts.signal) {
    if (opts.signal.aborted) {
      await safeDestroy(loadingTask)
      throw new Error('aborted')
    }
    onAbort = (): void => {
      void safeDestroy(loadingTask)
    }
    opts.signal.addEventListener('abort', onAbort, { once: true })
  }

  let doc: PdfDocument
  try {
    doc = await loadingTask.promise
  } catch (err) {
    if (isPasswordException(err)) {
      throw new Error(EXTRACTOR_ERROR_ENCRYPTED)
    }
    throw err
  } finally {
    if (onAbort && opts.signal) opts.signal.removeEventListener('abort', onAbort)
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
      page.cleanup?.()
    }
    const text = parts.join('\n')
    if (text.trim().length === 0) {
      // Cleanly-parsed but no text layer — the classic scanned PDF
      // case. Report as `no-text-layer`, not `empty`, so A4 can
      // surface "we couldn't read this file" rather than "we read
      // it and it was empty".
      throw new Error(EXTRACTOR_ERROR_NO_TEXT_LAYER)
    }
    return { kind: 'text', text }
  } finally {
    await safeDestroy(loadingTask)
  }
}

async function safeDestroy(loadingTask: PdfLoadingTask): Promise<void> {
  try {
    await loadingTask.destroy()
  } catch {
    // destroy() rejects on already-destroyed tasks; nothing to do.
  }
}

interface PdfLoadingTask {
  readonly promise: Promise<PdfDocument>
  destroy(): Promise<void>
}
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

/** Test seam: reset the cached pdf.js promise so a fresh import fires. */
export function __resetPdfjsForTesting(): void {
  pdfjsPromise = null
}
