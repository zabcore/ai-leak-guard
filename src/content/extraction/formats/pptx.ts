// V1.2 A2 PPTX text extractor.
//
// A `.pptx` is a ZIP archive; slide text lives in
// `ppt/slides/slide1.xml`, `slide2.xml`, … as `<a:t>…</a:t>` runs.
// We process slides in numeric order (slide1 before slide10) so
// extracted text preserves reading order — matters if A3 wants to
// attribute a finding to a slide range in a future release.
//
// Same rationale as `docx.ts`: primitive XML scan on top of jszip,
// no macros, no HTML conversion, small dep footprint.
//
// ZIP-bomb defence: each slide's uncompressed size is checked
// individually, and a running total is enforced across all slides.
// A crafted deck cannot expand to gigabytes.

import JSZip from 'jszip'
import type { FormatOutput } from '../extract'
import { decodeXmlEntities } from './xml-text'

// Same per-entry cap as docx (see `docx.ts` for rationale).
export const MAX_UNCOMPRESSED_ENTRY_BYTES = 40 * 1024 * 1024
// Cumulative cap across ALL slides in a single deck. A large deck
// with hundreds of slides is expected; a deck that lies about slide
// sizes to sneak past the per-entry cap is not.
export const MAX_TOTAL_UNCOMPRESSED_BYTES = 80 * 1024 * 1024

export async function extractPptx(file: File): Promise<FormatOutput> {
  const buf = await file.arrayBuffer()
  const zip = await JSZip.loadAsync(buf)
  const slideNames = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort(slideNumericOrder)
  if (slideNames.length === 0) {
    return { kind: 'reason' }
  }
  const parts: string[] = []
  let totalUncompressed = 0
  for (const name of slideNames) {
    const entry = zip.file(name)
    if (!entry) continue
    const declared = uncompressedSizeOf(entry)
    if (declared !== null) {
      if (declared > MAX_UNCOMPRESSED_ENTRY_BYTES) {
        return { kind: 'reason', reason: 'too-large' }
      }
      totalUncompressed += declared
      if (totalUncompressed > MAX_TOTAL_UNCOMPRESSED_BYTES) {
        return { kind: 'reason', reason: 'too-large' }
      }
    }
    const xml = await entry.async('string')
    parts.push(pptxSlideXmlToText(xml))
  }
  return { kind: 'text', text: parts.join('\n\n') }
}

function slideNumericOrder(a: string, b: string): number {
  const na = Number(a.match(/slide(\d+)\.xml$/)?.[1] ?? 0)
  const nb = Number(b.match(/slide(\d+)\.xml$/)?.[1] ?? 0)
  return na - nb
}

function uncompressedSizeOf(entry: JSZip.JSZipObject): number | null {
  const rec = (entry as unknown as { _data?: { uncompressedSize?: number } })._data
  if (!rec) return null
  const n = rec.uncompressedSize
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return null
  return n
}

/**
 * Minimal projection: `<a:t …>…</a:t>` runs joined with spaces
 * within a paragraph, paragraphs (`<a:p …>`) separated by `\n`.
 * Exported for unit-testing without a real .pptx.
 */
export function pptxSlideXmlToText(xml: string): string {
  const out: string[] = []
  const re = /<a:p\b[^>]*\/?>|<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) {
    const tag = m[0]
    if (tag.startsWith('<a:p')) {
      out.push('\n')
    } else {
      out.push(decodeXmlEntities(m[1] ?? ''))
    }
  }
  return out.join('').replace(/\n{3,}/g, '\n\n')
}
