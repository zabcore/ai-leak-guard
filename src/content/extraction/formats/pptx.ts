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
// ZIP-bomb defence: each slide is decompressed through the streaming
// `readEntryBoundedText` reader (per-entry cap enforced mid-stream),
// plus a running cumulative cap across ALL slides. Falsified /
// missing size headers are treated as `too-large` (fail-closed).

import JSZip from 'jszip'
import type { FormatOutput } from '../extract'
import { decodeXmlEntities } from './xml-text'
import { readEntryBoundedText } from './zip-read'

// Same per-entry cap as docx (see `docx.ts` for rationale).
export const MAX_UNCOMPRESSED_ENTRY_BYTES = 40 * 1024 * 1024
// Cumulative cap across ALL slides in a single deck. A large deck
// with hundreds of slides is expected; a deck that stitches together
// many entries to sneak past the per-entry cap is not.
export const MAX_TOTAL_UNCOMPRESSED_BYTES = 80 * 1024 * 1024

export interface ExtractPptxOptions {
  readonly signal?: AbortSignal
}

export async function extractPptx(
  file: File,
  opts: ExtractPptxOptions = {},
): Promise<FormatOutput> {
  const buf = await file.arrayBuffer()
  const zip = await JSZip.loadAsync(buf)
  const slideNames = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort(slideNumericOrder)
  if (slideNames.length === 0) {
    return { kind: 'reason' }
  }
  const parts: string[] = []
  let totalBytes = 0
  for (const name of slideNames) {
    if (opts.signal?.aborted) return { kind: 'reason', reason: 'timeout' }
    const entry = zip.file(name)
    if (!entry) continue
    // Shrink the cap for this entry so a slide can't push the
    // cumulative total past the deck cap — even if its own declared
    // size is under the per-entry cap.
    const remaining = MAX_TOTAL_UNCOMPRESSED_BYTES - totalBytes
    if (remaining <= 0) {
      return { kind: 'reason', reason: 'too-large' }
    }
    const perEntryCap = Math.min(MAX_UNCOMPRESSED_ENTRY_BYTES, remaining)
    const read = await readEntryBoundedText(entry, {
      cap: perEntryCap,
      failClosedIfUnknownSize: true,
      signal: opts.signal,
    })
    if (read.kind === 'over-cap') {
      return { kind: 'reason', reason: 'too-large' }
    }
    if (read.kind === 'aborted') {
      return { kind: 'reason', reason: 'timeout' }
    }
    if (read.kind === 'stream-error') {
      return { kind: 'reason' }
    }
    totalBytes += read.bytesRead
    parts.push(pptxSlideXmlToText(read.text))
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
