// V1.2 A2 local document text extraction.
//
// Turns a held file's bytes → plain text, entirely locally, so A3 can
// run the existing detector over the resulting text. The extractor
// itself does NOT run detection (A3) and does NOT touch UI (A4). What
// this file owns:
//
//   1. Format sniffing (magic-bytes-first, extension/MIME as
//      tiebreaker) so a mislabeled `.pdf` that is actually a JPG is
//      classified as `no-text-layer`, not `parse-error`.
//   2. Hard safety guards — 20 MB size cap, 10 s per-file timeout,
//      global try/catch — so `extractText` NEVER throws and cannot
//      hang the hold flow no matter what the file contains.
//   3. Dispatch to a per-format module that is loaded LAZILY via
//      dynamic `import()`. This keeps `pdfjs-dist` and `xlsx`
//      (multi-hundred-KB each) out of the main content bundle so
//      flag-OFF / paste-only sessions never pay for them.
//
// Non-negotiable invariants (mirrored in `docs/ARCHITECTURE.md`):
//   • **Zero network.** No extractor may `fetch()`, `XHR`, or load a
//     remote font/worker. pdf.js runs with `isEvalSupported:false`
//     and a locally-bundled worker; a no-network test asserts this.
//   • **In-memory only.** Extracted text NEVER touches
//     `chrome.storage`, IndexedDB, the DOM, or the network. The A5
//     event log stays metadata-only — A2 must not weaken that.
//   • **Treat every file as hostile.** Any thrown parser →
//     `unable_to_inspect / parse-error`; any hang → `timeout`.

export type ExtractionStatus = 'extracted' | 'empty' | 'unable_to_inspect'

export type ExtractionReason =
  | 'encrypted'
  | 'no-text-layer'
  | 'too-large'
  | 'timeout'
  | 'unsupported-type'
  | 'parse-error'
  | 'empty'

/**
 * Format the sniffer decided on. `'unknown'` means neither magic
 * bytes, extension, nor MIME identified the file; the extractor then
 * reports `unable_to_inspect / unsupported-type`. Deliberately a
 * small, closed set so downstream code (A4 modal copy, A5 event log)
 * can switch exhaustively.
 */
export type DetectedFormat = 'pdf' | 'docx' | 'xlsx' | 'pptx' | 'text' | 'csv' | 'unknown'

export interface ExtractionMeta {
  readonly name: string
  readonly size: number
  readonly type: string
  readonly detectedFormat: DetectedFormat
}

export interface ExtractionResult {
  readonly status: ExtractionStatus
  /** Non-empty only when `status === 'extracted'`. */
  readonly text: string
  /** Present when `status !== 'extracted'`; explains why. */
  readonly reason?: ExtractionReason
  readonly meta: ExtractionMeta
}

// 20 MB. Anything larger short-circuits to `too-large` without
// touching a parser — protects against a hostile pathological PDF /
// docx / xlsx that would OOM the tab.
export const MAX_EXTRACTION_BYTES = 20 * 1024 * 1024

// 10 s per file. Race against the parser; on timeout, resolve to
// `unable_to_inspect / timeout` and let the parser Promise fall to
// the floor (garbage collected once its ArrayBuffer refs drop).
export const EXTRACTION_TIMEOUT_MS = 10_000

// Bytes we need to sniff the header. `%PDF-` is 5 bytes; ZIP local
// file header is 4. 8 gives us margin for future magic prefixes.
const SNIFF_BYTES = 8

/**
 * Public entry point. Never throws. Every failure mode is expressed
 * as a value in the returned `ExtractionResult`.
 *
 * Contract:
 *   • `status: 'extracted'` — text was successfully pulled out. May
 *     still contain trailing whitespace but is guaranteed non-empty
 *     (a cleanly-parsed but empty document returns `status: 'empty'`
 *     instead).
 *   • `status: 'empty'` — parsed successfully, no text present. The
 *     file COULD be inspected; there was just nothing to inspect.
 *     Distinct from `unable_to_inspect` so A4 can distinguish
 *     "reviewed, no PHI" from "could not review".
 *   • `status: 'unable_to_inspect'` — could not read; `reason`
 *     narrows why. Never a silent pass: A4 will surface this to the
 *     user rather than defaulting to "OK".
 */
export async function extractText(file: File): Promise<ExtractionResult> {
  const baseMeta = { name: file.name, size: file.size, type: file.type }

  // 1. Size cap — enforced BEFORE any parser is invoked. A hostile
  //    500 MB "pdf" cannot force pdfjs to allocate anything.
  if (file.size > MAX_EXTRACTION_BYTES) {
    return {
      status: 'unable_to_inspect',
      text: '',
      reason: 'too-large',
      meta: { ...baseMeta, detectedFormat: 'unknown' },
    }
  }

  // 2. Sniff format (may still be 'unknown').
  const detectedFormat = await sniffFormatSafe(file)
  const meta: ExtractionMeta = { ...baseMeta, detectedFormat }

  if (detectedFormat === 'unknown') {
    return {
      status: 'unable_to_inspect',
      text: '',
      reason: 'unsupported-type',
      meta,
    }
  }

  // 3. Race the actual extractor against a cancellable timeout.
  //    Two guarantees:
  //      • On extractor success/failure, the timer is CLEARED so its
  //        setTimeout doesn't keep the closure alive for the full
  //        10 s (multiplied by the number of files in a drop).
  //      • On timeout, an AbortSignal fires so per-format extractors
  //        that support cancellation (pdf.js via
  //        `loadingTask.destroy()`) release the underlying worker
  //        rather than continuing to parse a hostile file in the
  //        background.
  const ac = new AbortController()
  const timer = createTimeoutSentinel(meta)
  try {
    const result = await Promise.race([
      runExtractor(file, detectedFormat, meta, ac.signal),
      timer.promise,
    ])
    if (result.reason === 'timeout') ac.abort()
    return result
  } catch (err) {
    void err
    return {
      status: 'unable_to_inspect',
      text: '',
      reason: 'parse-error',
      meta,
    }
  } finally {
    timer.cancel()
  }
}

interface TimeoutSentinel {
  readonly promise: Promise<ExtractionResult>
  readonly cancel: () => void
}

function createTimeoutSentinel(meta: ExtractionMeta): TimeoutSentinel {
  let handle: ReturnType<typeof setTimeout> | undefined
  const promise = new Promise<ExtractionResult>((resolve) => {
    handle = setTimeout(() => {
      resolve({
        status: 'unable_to_inspect',
        text: '',
        reason: 'timeout',
        meta,
      })
    }, EXTRACTION_TIMEOUT_MS)
  })
  return {
    promise,
    cancel: () => {
      if (handle !== undefined) clearTimeout(handle)
    },
  }
}

async function runExtractor(
  file: File,
  format: DetectedFormat,
  meta: ExtractionMeta,
  signal: AbortSignal,
): Promise<ExtractionResult> {
  try {
    switch (format) {
      case 'pdf': {
        const mod = await import('./formats/pdf')
        return finalize(await mod.extractPdf(file, { signal }), meta)
      }
      case 'xlsx': {
        const mod = await import('./formats/xlsx')
        return finalize(await mod.extractXlsx(file), meta)
      }
      case 'docx': {
        const mod = await import('./formats/docx')
        return finalize(await mod.extractDocx(file), meta)
      }
      case 'pptx': {
        const mod = await import('./formats/pptx')
        return finalize(await mod.extractPptx(file), meta)
      }
      case 'text':
      case 'csv': {
        const mod = await import('./formats/text')
        return finalize(await mod.extractPlainText(file), meta)
      }
      case 'unknown':
        return {
          status: 'unable_to_inspect',
          text: '',
          reason: 'unsupported-type',
          meta,
        }
    }
  } catch (err) {
    return classifyExtractorError(err, meta)
  }
}

/**
 * Per-format modules return a minimal `FormatOutput` — either the
 * extracted text or a reason. `finalize` wraps that into the public
 * `ExtractionResult` shape, applying the `empty` distinction.
 */
export interface FormatOutput {
  readonly kind: 'text' | 'reason'
  readonly text?: string
  readonly reason?: ExtractionReason
}

function finalize(out: FormatOutput, meta: ExtractionMeta): ExtractionResult {
  if (out.kind === 'reason') {
    return {
      status: 'unable_to_inspect',
      text: '',
      reason: out.reason ?? 'parse-error',
      meta,
    }
  }
  const text = (out.text ?? '').trim()
  if (text.length === 0) {
    return { status: 'empty', text: '', reason: 'empty', meta }
  }
  // Return the ORIGINAL (untrimmed) text — trailing whitespace can
  // matter to the detector, and we already know the trimmed version
  // is non-empty.
  return { status: 'extracted', text: out.text ?? '', meta }
}

// Extractor modules signal password / no-text conditions by throwing
// a plain `Error` whose message we tag here. Kept in one place so a
// per-format extractor doesn't need to know the public reason vocab.
export const EXTRACTOR_ERROR_ENCRYPTED = 'ALG_EXTRACTOR_ENCRYPTED'
export const EXTRACTOR_ERROR_NO_TEXT_LAYER = 'ALG_EXTRACTOR_NO_TEXT_LAYER'

function classifyExtractorError(err: unknown, meta: ExtractionMeta): ExtractionResult {
  const message = err instanceof Error ? err.message : String(err)
  if (message === EXTRACTOR_ERROR_ENCRYPTED) {
    return { status: 'unable_to_inspect', text: '', reason: 'encrypted', meta }
  }
  if (message === EXTRACTOR_ERROR_NO_TEXT_LAYER) {
    return { status: 'unable_to_inspect', text: '', reason: 'no-text-layer', meta }
  }
  return { status: 'unable_to_inspect', text: '', reason: 'parse-error', meta }
}

// ─── Format sniffing ────────────────────────────────────────────────────

async function sniffFormatSafe(file: File): Promise<DetectedFormat> {
  try {
    return await sniffFormat(file)
  } catch {
    return 'unknown'
  }
}

/**
 * Magic-bytes-first sniffer. Extension / MIME are only consulted to
 * distinguish members of the same container family (a ZIP could be
 * docx, xlsx, pptx, or an unrelated ZIP) or when the byte header is
 * ambiguous (plain text has no magic).
 *
 * Design point: we do NOT trust the extension over the header. A JPG
 * renamed to `report.pdf` sniffs as JPG → `unknown`, which surfaces
 * as `unable_to_inspect / unsupported-type` — the correct honest
 * outcome, not a fake `parse-error`.
 */
export async function sniffFormat(file: File): Promise<DetectedFormat> {
  const head = new Uint8Array(await file.slice(0, SNIFF_BYTES).arrayBuffer())

  // PDF: `%PDF-` (25 50 44 46 2D). Any file starting with this is
  // treated as PDF regardless of extension.
  if (
    head.length >= 5 &&
    head[0] === 0x25 &&
    head[1] === 0x50 &&
    head[2] === 0x44 &&
    head[3] === 0x46 &&
    head[4] === 0x2d
  ) {
    return 'pdf'
  }

  // ZIP local file header: `PK\x03\x04` (50 4B 03 04). Could be
  // docx / xlsx / pptx / plain ZIP. Extension breaks the tie.
  if (
    head.length >= 4 &&
    head[0] === 0x50 &&
    head[1] === 0x4b &&
    head[2] === 0x03 &&
    head[3] === 0x04
  ) {
    const ext = fileExtension(file.name)
    if (ext === 'docx') return 'docx'
    if (ext === 'xlsx') return 'xlsx'
    if (ext === 'pptx') return 'pptx'
    // A .zip we cannot classify without peeking further. Report
    // unknown so the user sees an honest "could not inspect".
    return 'unknown'
  }

  // Text-family sniff by extension/MIME. We deliberately do NOT
  // trust arbitrary UTF-8 heuristics on unknown extensions — that
  // path caused false positives in earlier prototypes where binary
  // fixtures with a leading ASCII header were treated as text.
  const ext = fileExtension(file.name)
  if (ext === 'txt' || ext === 'md') return 'text'
  if (ext === 'csv') return 'csv'
  const mime = file.type.toLowerCase()
  if (mime === 'text/plain' || mime === 'text/markdown') return 'text'
  if (mime === 'text/csv' || mime === 'application/csv') return 'csv'

  return 'unknown'
}

function fileExtension(name: string): string {
  const dot = name.lastIndexOf('.')
  if (dot < 0 || dot === name.length - 1) return ''
  return name.slice(dot + 1).toLowerCase()
}
