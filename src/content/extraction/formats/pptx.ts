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

import JSZip from 'jszip'
import type { FormatOutput } from '../extract'

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
  for (const name of slideNames) {
    const entry = zip.file(name)
    if (!entry) continue
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
