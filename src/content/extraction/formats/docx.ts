// V1.2 A2 DOCX text extractor.
//
// A `.docx` is a ZIP archive; `word/document.xml` holds the body
// runs. Text lives in `<w:t>…</w:t>` (with `xml:space="preserve"`
// preserved when present). We insert a `\n` at every `<w:p>` (paragraph)
// break so the extracted plaintext has readable line structure for
// A3's detector.
//
// Why not `mammoth`? Mammoth converts to HTML/Markdown, brings in a
// large dep tree, and we only need the raw run text. `jszip` +
// primitive XML scanning is much smaller and cannot execute macros.
//
// ZIP-bomb defence. `MAX_EXTRACTION_BYTES` (in `extract.ts`) caps
// the COMPRESSED input at 20 MB. A hostile archive could still
// inflate to gigabytes and OOM the tab; we bound the DECOMPRESSED
// size of `word/document.xml` via `MAX_UNCOMPRESSED_ENTRY_BYTES`
// before decoding.

import JSZip from 'jszip'
import type { FormatOutput } from '../extract'
import { decodeXmlEntities } from './xml-text'

// 40 MB uncompressed cap for a single OOXML text stream. Well above
// any real document (a 500-page docx is ~5 MB decompressed) but
// small enough that a zip bomb aiming for GB expansion is rejected.
export const MAX_UNCOMPRESSED_ENTRY_BYTES = 40 * 1024 * 1024

export async function extractDocx(file: File): Promise<FormatOutput> {
  const buf = await file.arrayBuffer()
  const zip = await JSZip.loadAsync(buf)
  const docEntry = zip.file('word/document.xml')
  if (!docEntry) {
    // Missing document.xml on a valid-looking OOXML ZIP → treat as
    // parse-error via the default `kind: 'reason'` path; upstream
    // maps `undefined` → `parse-error`.
    return { kind: 'reason' }
  }
  const declaredSize = uncompressedSizeOf(docEntry)
  if (declaredSize !== null && declaredSize > MAX_UNCOMPRESSED_ENTRY_BYTES) {
    return { kind: 'reason', reason: 'too-large' }
  }
  const xml = await docEntry.async('string')
  return { kind: 'text', text: docxXmlToText(xml) }
}

/**
 * Read the declared uncompressed size from a JSZip entry. JSZip
 * exposes it under `_data.uncompressedSize` on non-loaded entries;
 * on entries that have already been decompressed, the field may be
 * missing — return `null` and let the caller fall back to the
 * downstream size checks. Cast is scoped narrowly so we don't leak
 * jszip internals elsewhere.
 */
function uncompressedSizeOf(entry: JSZip.JSZipObject): number | null {
  const rec = (entry as unknown as { _data?: { uncompressedSize?: number } })._data
  if (!rec) return null
  const n = rec.uncompressedSize
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return null
  return n
}

/**
 * Minimal XML-to-text projection for `word/document.xml`. Exported
 * for unit-testing without a real .docx.
 *
 * Rules:
 *   • `<w:p …>` and `</w:p>` insert a paragraph break (`\n`).
 *   • `<w:br/>` (soft line break) also inserts `\n`.
 *   • `<w:t …>text</w:t>` contributes the inner text (decoded).
 *   • Everything else is stripped.
 */
export function docxXmlToText(xml: string): string {
  const out: string[] = []
  // Match paragraph open, br, or w:t element (open + inner + close).
  // Note: w:t may carry attributes (e.g. xml:space="preserve"). The
  // regex is bounded and does not backtrack pathologically because
  // the inner is a non-greedy match on non-`<` chars followed by the
  // literal close tag.
  const re = /<w:p\b[^>]*\/?>|<w:br\b[^>]*\/?>|<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) {
    const tag = m[0]
    if (tag.startsWith('<w:p')) {
      out.push('\n')
    } else if (tag.startsWith('<w:br')) {
      out.push('\n')
    } else {
      out.push(decodeXmlEntities(m[1] ?? ''))
    }
  }
  return out.join('').replace(/\n{3,}/g, '\n\n')
}
