// V1.2 M6.1 rich-text paste extractor.
//
// The V1.1 paste handler read only `clipboardData.getData('text/plain')`
// and returned early on empty. That broke a real user scenario the
// M6 GA smoke uncovered: copying identifiers out of a rich-text web
// app (a web EMR, Google Docs, Notion, Microsoft 365 web) puts the
// content in `text/html` with an absent or empty `text/plain` slot,
// so the handler saw an empty string, bailed out, and never even
// invoked detection. Detection LITERALLY didn't run. That's the
// worst kind of failure for a masking extension — silent, invisible,
// and easy to blame on "it just doesn't work here" without ever
// knowing the extension short-circuited.
//
// This helper is the single choke-point for "get pasted text out of
// a ClipboardData/DataTransfer". Callers hand it the event's
// `clipboardData` and get back one of three outcomes:
//
//   • `source: 'plain'` — `text/plain` had non-empty content;
//     use that (the V1.1 path).
//   • `source: 'html'`  — `text/plain` was empty/absent but
//     `text/html` had content; the helper stripped it to plain
//     text via an INERT `DOMParser` (no scripts run, no network,
//     no side effects on the calling document).
//   • `source: 'none'` — no readable text on either slot. The
//     `hadContent` flag says whether the clipboard had ANY
//     non-`Files` bytes we couldn't decode (a custom MIME type, an
//     image-only paste that we still want the file branch to see,
//     etc.). Callers use that to decide between silent-no-op (no
//     content at all) and log-as-`unable-to-inspect` (there was
//     content but we couldn't get plaintext out of it).
//
// The extracted text is capped at `MAX_HTML_STRIP_CHARS` so a
// hostile page can't hand us a 100 MB `text/html` payload and
// stall the paste flow. This matches the same-shape guard the
// document-extractor uses (`MAX_SCAN_CHARS`).
//
// Metadata-only discipline. This helper produces PLAINTEXT that
// the detection engine consumes — the SAME shape a plain-text
// paste already produces. The A5 event log invariant is unchanged:
// nothing here writes to storage, nothing here logs the extracted
// text, and the resulting string leaves scope as soon as detection
// finishes with it.

/**
 * Same cap the document extractor uses. Big enough to cover any
 * realistic rich-text paste (a whole novel is ~500 KB); small
 * enough that a hostile page can't stall the flow with a many-MB
 * payload. Kept as a local constant rather than imported from
 * `file-inspector.ts` so this module has zero dependency on the
 * document-protection surface.
 */
export const MAX_HTML_STRIP_CHARS = 2_000_000

export type ClipboardTextSource = 'plain' | 'html' | 'none'

export interface ReadPastedText {
  /** Extracted plain text. Empty when `source === 'none'`. */
  readonly text: string
  /** Which slot the text came from — for logging + tests. */
  readonly source: ClipboardTextSource
  /**
   * True when the clipboard had non-`Files` entries with bytes we
   * couldn't extract as plaintext. Callers use this to distinguish
   * a genuine empty paste (both flags false, silent no-op) from a
   * paste we FAILED to inspect (log as `unable-to-inspect` so the
   * user's activity log records the miss).
   */
  readonly hadContent: boolean
}

/**
 * Read plaintext out of a `DataTransfer` / `ClipboardData` with
 * a rich-text fallback. Never throws — a malformed HTML payload
 * or a browser that refuses one of the reads still returns a
 * well-shaped `ReadPastedText` (with `source: 'none'` in the
 * worst case).
 *
 * Layered so the fast/normal case is `text/plain` and only
 * rich-text sources pay the DOMParser cost.
 */
export function readPastedText(cd: DataTransfer | null): ReadPastedText {
  if (cd === null) {
    return { text: '', source: 'none', hadContent: false }
  }

  // (a) text/plain — the V1.1 path. Trim to catch the "whitespace
  // only" case that a rich-text source occasionally emits alongside
  // the real html payload.
  const plain = safeGetData(cd, 'text/plain')
  if (plain.trim().length > 0) {
    return { text: plain, source: 'plain', hadContent: true }
  }

  // (b) text/html — strip via an inert DOMParser. `DOMParser` runs
  // NO scripts by design (per the WHATWG HTML spec, it's a passive
  // parser — no `<script>` execution, no resource fetches from
  // `<img src>` / `<link>` / `<iframe>`). The parsed document is
  // detached from the calling window: it has its own document, its
  // own DOM tree, and neither runs event handlers nor hits the
  // network. `body.textContent` returns the visible text with
  // whitespace preserved.
  const html = safeGetData(cd, 'text/html')
  if (html.length > 0) {
    const stripped = stripHtmlToText(html)
    if (stripped.length > 0) {
      return { text: stripped, source: 'html', hadContent: true }
    }
  }

  // (c) fall-through: no plaintext, but check whether the clipboard
  // carried ANY non-`Files` entry with bytes. `cd.types` includes
  // string-type MIMEs (`text/plain`, `text/html`, arbitrary custom
  // types like `text/rtf`, `application/x-*`, …) plus the sentinel
  // `Files` when a file/image is attached. Anything non-`Files`
  // with a getData() result counts as "we saw content we couldn't
  // decode".
  let hadNonFileBytes = false
  try {
    for (const type of cd.types ?? []) {
      if (type === 'Files') continue
      const bytes = safeGetData(cd, type)
      if (bytes.length > 0) {
        hadNonFileBytes = true
        break
      }
    }
  } catch {
    // Some browsers throw on cross-origin clipboard access to
    // certain MIME types. That's the "we don't know" case — the
    // caller can still decide whether to log unable-to-inspect
    // based on other signals, but from this helper's perspective
    // we saw nothing.
  }

  return { text: '', source: 'none', hadContent: hadNonFileBytes }
}

/**
 * `getData` never throws in modern browsers, but wrap it defensively
 * — a browser update that changes the throwing behavior on a
 * disallowed MIME must not crash the paste handler. Returns '' on
 * any error.
 */
function safeGetData(cd: DataTransfer, type: string): string {
  try {
    return cd.getData(type) ?? ''
  } catch {
    return ''
  }
}

/**
 * Parse an HTML fragment into a detached document via `DOMParser`
 * and return `body.textContent` with a length cap. Kept exported so
 * a component test can pin the "no script execution" invariant
 * without going through the full clipboard-shaped API.
 */
export function stripHtmlToText(html: string): string {
  // Hard-cap the INPUT too — a 100 MB HTML payload would still be
  // expensive to parse before the output cap kicks in.
  const bounded = html.length > MAX_HTML_STRIP_CHARS ? html.slice(0, MAX_HTML_STRIP_CHARS) : html
  let doc: Document
  try {
    doc = new DOMParser().parseFromString(bounded, 'text/html')
  } catch {
    return ''
  }
  const raw = doc.body?.textContent ?? ''
  // `textContent` on the parsed body preserves the original visible
  // whitespace, which is what the detector regexes were tuned on.
  // Trim only the outer edges so a rich-text paste that begins with
  // "  " doesn't derail an anchored regex.
  const trimmed = raw.trim()
  return trimmed.length > MAX_HTML_STRIP_CHARS ? trimmed.slice(0, MAX_HTML_STRIP_CHARS) : trimmed
}
