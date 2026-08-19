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
// the COMPRESSED input at 20 MB. Decompression itself is bounded by
// `readEntryBoundedText`, which streams chunks through
// jszip's `internalStream` and rejects as soon as the running total
// crosses `MAX_UNCOMPRESSED_ENTRY_BYTES` — so a hostile archive with
// a falsified `_data.uncompressedSize` cannot force us to allocate
// gigabytes. Missing / unreadable size metadata is treated as
// `too-large` (fail-closed).

import JSZip from 'jszip'
import type { FormatOutput } from '../extract'
import { decodeXmlEntities } from './xml-text'
import { readEntryBoundedText } from './zip-read'

// 40 MB uncompressed cap for the document body. Well above any real
// document (a 500-page docx is ~5 MB decompressed) but small enough
// that a zip bomb aiming for GB expansion is rejected mid-stream.
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
  const read = await readEntryBoundedText(docEntry, {
    cap: MAX_UNCOMPRESSED_ENTRY_BYTES,
    failClosedIfUnknownSize: true,
  })
  if (read.kind === 'over-cap') {
    return { kind: 'reason', reason: 'too-large' }
  }
  if (read.kind === 'stream-error') {
    return { kind: 'reason' }
  }
  return { kind: 'text', text: docxXmlToText(read.text) }
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
