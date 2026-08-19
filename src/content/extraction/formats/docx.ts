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

import JSZip from 'jszip'
import type { FormatOutput } from '../extract'

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
  const xml = await docEntry.async('string')
  return { kind: 'text', text: docxXmlToText(xml) }
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

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&')
}
