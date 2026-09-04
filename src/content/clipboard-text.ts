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

  // `safeGetData` swallows getData() exceptions and returns ''. A
  // browser that refuses a specific MIME cross-origin is
  // indistinguishable from an empty slot by return value alone; the
  // moot difference matters because the paste handler MUST log
  // unable-to-inspect when the read FAILED (there was content we
  // couldn't see) vs. silently no-op when the slot was truly empty.
  // Track failures out-of-band so the fall-through knows.
  const readState = { errors: 0 }
  const read = (type: string): string => safeGetData(cd, type, readState)

  // (a) text/plain — the V1.1 path. Trim to catch the "whitespace
  // only" case that a rich-text source occasionally emits alongside
  // the real html payload.
  const plain = read('text/plain')
  if (plain.trim().length > 0) {
    return { text: plain, source: 'plain', hadContent: true }
  }

  // (b) text/html — strip via an inert DOMParser. `DOMParser` runs
  // NO scripts by design (per the WHATWG HTML spec, it's a passive
  // parser — no `<script>` execution, no resource fetches from
  // `<img src>` / `<link>` / `<iframe>`). The parsed document is
  // detached from the calling window: it has its own document, its
  // own DOM tree, and neither runs event handlers nor hits the
  // network.
  const html = read('text/html')
  if (html.length > 0) {
    // Oversized payload: inspecting only a truncated prefix would
    // give the user a false sense of security — detection could
    // return clean on the prefix, the handler allows native paste,
    // and the FULL sensitive payload lands in the site's editor.
    // Refuse to parse and hand the caller a definitive
    // unable-to-inspect signal.
    if (html.length > MAX_HTML_STRIP_CHARS) {
      return { text: '', source: 'none', hadContent: true }
    }
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
  // decode". A prior read error also counts — the browser refused
  // us but the bytes were there.
  let hadNonFileBytes = readState.errors > 0
  try {
    for (const type of cd.types ?? []) {
      if (type === 'Files') continue
      const bytes = read(type)
      if (bytes.length > 0) {
        hadNonFileBytes = true
        break
      }
    }
  } catch {
    // The `types` accessor itself threw (some browsers do this on
    // cross-origin clipboard access). Treat as "we don't know" —
    // if a prior read threw, `hadNonFileBytes` already reflects it
    // via readState.errors; otherwise leave as-is.
  }
  // Any error during the fall-through scan also counts.
  if (readState.errors > 0) hadNonFileBytes = true

  return { text: '', source: 'none', hadContent: hadNonFileBytes }
}

/**
 * `getData` never throws in modern browsers, but wrap it defensively
 * — a browser update that changes the throwing behavior on a
 * disallowed MIME must not crash the paste handler. Returns '' on
 * any error, and increments `state.errors` so the caller can
 * distinguish an empty slot from a slot the browser refused.
 */
function safeGetData(cd: DataTransfer, type: string, state?: { errors: number }): string {
  try {
    return cd.getData(type) ?? ''
  } catch {
    if (state) state.errors += 1
    return ''
  }
}

// Elements whose textContent is either invisible or non-user-facing
// script/style source. `body.textContent` includes ALL descendant
// text including <script> and <style>, which would let a hostile
// paste smuggle SSN-shaped strings inside a `<script>` block that
// the detector treats as real visible content. Strip these before
// extracting text. `<title>`, `<meta>`, and `<link>` are only
// possible inside `<head>` for a real parsed document but
// DOMParser's tolerance means they can also land inside `<body>`
// on hostile input, so we scrub them too.
const NON_CONTENT_TAGS: readonly string[] = [
  'script',
  'style',
  'noscript',
  'template',
  'iframe',
  'object',
  'embed',
  'title',
  'meta',
  'link',
]

// Block-level tags whose boundary should introduce whitespace in
// the extracted text. Without this, `<div>foo</div><div>bar</div>`
// collapses to `"foobar"` via body.textContent — an adjacent-token
// merge that can spuriously match a detector regex or (worse) hide
// a real match by joining an identifier with surrounding chrome.
const BLOCK_TAGS: ReadonlySet<string> = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'br',
  'caption',
  'dd',
  'details',
  'dialog',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hgroup',
  'hr',
  'li',
  'main',
  'nav',
  'ol',
  'option',
  'p',
  'pre',
  'section',
  'summary',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'ul',
])

/**
 * Parse an HTML fragment into a detached document via `DOMParser`
 * and return the visible text, with non-content tags (script /
 * style / …) removed and separators inserted at block-element and
 * `<br>` boundaries. Kept exported so a component test can pin the
 * "no script execution" invariant without going through the full
 * clipboard-shaped API.
 *
 * Returns `''` on an oversized input — `readPastedText`'s caller
 * short-circuits before parsing and treats it as
 * unable-to-inspect. Returning `''` here rather than a truncated
 * prefix keeps stripHtmlToText's own contract consistent for
 * direct callers: never partial, never a false-clean silhouette
 * of the real payload.
 */
export function stripHtmlToText(html: string): string {
  if (html.length > MAX_HTML_STRIP_CHARS) return ''
  let doc: Document
  try {
    doc = new DOMParser().parseFromString(html, 'text/html')
  } catch {
    return ''
  }
  const body = doc.body
  if (!body) return ''
  // Remove non-content elements before text extraction so their
  // source (inline JS, CSS, meta content) doesn't leak into the
  // detector input.
  for (const tag of NON_CONTENT_TAGS) {
    for (const el of body.querySelectorAll(tag)) el.remove()
  }
  const raw = extractVisibleText(body)
  // Collapse runs of whitespace but keep at least one — the
  // detector regexes were tuned to tolerate variable spacing but
  // NOT to see adjacent tokens as one string. Trim outer edges so
  // a rich-text paste that begins with "  " doesn't derail an
  // anchored regex.
  const normalized = raw
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return normalized.length > MAX_HTML_STRIP_CHARS
    ? normalized.slice(0, MAX_HTML_STRIP_CHARS)
    : normalized
}

/**
 * Recursively walk a parsed DOM node collecting only visible text,
 * inserting `'\n'` around block-level elements and for each
 * `<br>` so adjacent tokens don't collapse into one string.
 * NON_CONTENT_TAGS have already been removed by the caller; this
 * function does not need to skip them again.
 *
 * Adjacent INLINE children are joined through `joinBoundary` so a
 * rich-text source that serializes `<span>label</span><span>value</span>`
 * without whitespace between the tags doesn't glue the two into
 * `"labelvalue"`. The M6.1 fix inserted separators only at block /
 * `<br>` boundaries — the owner's re-smoke found real EMR-shape
 * payloads where label + value are consecutive `<span>`s with no
 * whitespace at all between them, which would collapse to e.g.
 * `"Medical record numberMRN 12345678"` or `"SSN123-45-6789"` and
 * blow past the detector's word-boundary anchors (`\b`), silently
 * missing the MRN or SSN while the modal claimed protection.
 */
function extractVisibleText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? ''
  if (node.nodeType !== Node.ELEMENT_NODE) return ''
  const el = node as Element
  const tag = el.nodeName.toLowerCase()
  if (tag === 'br') return '\n'
  let text = ''
  for (const child of Array.from(el.childNodes)) {
    text = joinBoundary(text, extractVisibleText(child))
  }
  if (BLOCK_TAGS.has(tag)) return '\n' + text + '\n'
  return text
}

// Unicode word-character anchors used by `joinBoundary`. `\p{L}` =
// any letter, `\p{N}` = any digit — Unicode-aware so identifiers
// in non-ASCII names still get un-glued correctly. Regex literals
// with `/u` are re-usable — no state, no lastIndex concerns.
const WORD_END = /[\p{L}\p{N}]$/u
const WORD_START = /^[\p{L}\p{N}]/u
const LETTER_END = /\p{L}$/u
const LETTER_START = /^\p{L}/u

/**
 * Insert a single space between `acc` and `next` when both sides
 * end/start with a Unicode word char AND at least one side is a
 * LETTER — otherwise concat verbatim.
 *
 * Why this specific rule:
 *
 *   • Un-glues `numberMRN` (letter|letter) and `SSN123` (letter|
 *     digit) — the exact shape rich-text pastes from EMRs produce
 *     with `<span>Label</span><span>Value</span>` and no
 *     whitespace between the tags.
 *   • Does NOT insert a space at digit|digit boundaries: a numeric
 *     identifier split across inline spans — `<span>12345</span>
 *     <span>67893</span>` for an NPI, `<span>4111 1111</span>
 *     <span>1111 1111</span>` for a credit card — must remain
 *     contiguous so its length-based pattern (`\b\d{10}\b`, Luhn
 *     over 13-19 digits) still matches. The "digit|digit is safe
 *     to glue" bet holds because a rich-text source that separates
 *     two SEPARATE numeric identifiers almost always puts them in
 *     different rows (block-tag boundary → `\n`), not in bare
 *     adjacent inline spans.
 *   • Does NOT over-separate identifier-internal boundaries:
 *     `$` + `5` stays `$5` (`$` is not a word char); a dash-split
 *     identifier `123-45` + `-6789` stays `123-45-6789` (the second
 *     chunk starts with `-`, not a word char).
 *   • Even the false-positive direction (a stray space where the
 *     source had none) is the safe side for label/value un-glueing
 *     — the detector regexes tolerate variable whitespace between
 *     label and value.
 *
 * Kept an internal helper — no public callers outside this module,
 * and exporting would invite misuse.
 */
function joinBoundary(acc: string, next: string): string {
  if (
    acc.length > 0 &&
    next.length > 0 &&
    WORD_END.test(acc) &&
    WORD_START.test(next) &&
    (LETTER_END.test(acc) || LETTER_START.test(next))
  ) {
    return acc + ' ' + next
  }
  return acc + next
}
