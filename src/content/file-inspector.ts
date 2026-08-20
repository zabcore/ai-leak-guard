// V1.2 A3 file inspector.
//
// A1 shipped a stub that returned "no findings" for every file
// without reading a byte. A2 added real extraction — file bytes →
// plain text, attached as `entry.extraction`. **A3 wires the V1.1
// detector over that text** so a document is scanned for the same
// identifiers the paste path catches, and folds the outcome into a
// per-file + aggregate `DocScanResult` state the A4 modal will
// render.
//
// This is the single seam every document-flow path funnels through:
// the FSA picker (`fsa-isolated.ts`) and the change / drop / paste
// paths (`content/index.ts` → `document-flow.ts`) both call
// `inspectFiles`.
//
// Contract:
//   • Inputs: an array of `File` references. Callers must hold the
//     originals unchanged for the release path — the inspector NEVER
//     mutates or replaces files.
//   • Never throws. Extraction failures OR detection failures degrade
//     that one file to `extraction.status === 'unable_to_inspect'`
//     (reason `scan-error` when the extractor was fine but the
//     detector blew up); the surrounding flow always sees a resolved
//     promise so a hostile file cannot deny the user the hold modal.
//   • Metadata-only discipline. `findings` contain the matched
//     `value` for A4 to render inline (still in memory only); the
//     scan RESULT (`DocScanResult`) never carries the raw text and
//     is what A5 will log. Callers must not persist / log /
//     postMessage the `Finding.value`.

import { detectDetailed, isMaskable } from '../detector/engine'
import type { DetectionResult, Finding } from '../detector/types'
import { extractText, type ExtractionResult } from './extraction/extract'
import {
  aggregateScanResults,
  scanResultFor,
  type AggregateScanResult,
  type DocScanResult,
} from './extraction/scan-result'

export interface FileMeta {
  /** The original File object — reference only, not a byte copy. */
  readonly file: File
  /** File name as reported by the browser. Not surfaced in A3 UI. */
  readonly name: string
  /** Size in bytes. Not surfaced in A3 UI. */
  readonly size: number
  /** MIME type as reported by the browser. */
  readonly type: string
}

/**
 * Per-file inspection result. `extraction` holds the plaintext (and
 * the honest `unable_to_inspect` fallback); `findings` is populated
 * by the V1.1 detector; `scan` folds both into the summary state A4
 * renders.
 */
export interface FileInspectionEntry {
  readonly meta: FileMeta
  readonly extraction: ExtractionResult
  readonly findings: readonly Finding[]
  readonly scan: DocScanResult
}

export interface FileInspection {
  readonly perFile: readonly FileInspectionEntry[]
  /** Roll-up state across the whole drop — A4's headline copy comes
   *  from this. */
  readonly aggregate: AggregateScanResult
}

/**
 * Convenience aggregate — the flat list of findings across every
 * file. Kept in place for A4/A5 call sites that just want the raw
 * findings; new code should prefer `inspection.aggregate` for the
 * summary state.
 */
export function aggregateFindings(inspection: FileInspection): readonly Finding[] {
  const out: Finding[] = []
  for (const entry of inspection.perFile) out.push(...entry.findings)
  return out
}

// Small worker-pool limit for parallel extraction. `Promise.all`
// with no bound could hold N × `MAX_EXTRACTION_BYTES` in memory (a
// 50-file drop → ~1 GB), and every PDF ends up serialised on the
// single pdf.js worker anyway, so unbounded concurrency doesn't buy
// throughput. Four keeps a multi-file drop lively without inviting
// an OOM on a heavy paste.
export const MAX_CONCURRENT_EXTRACTIONS = 4

// V1.1 regexes were tuned on paste-sized inputs (a few KB). Document
// text is a new, larger distribution and any per-rule backtracking
// pathology would land HERE first. We refuse to scan text past this
// cap — the file is marked `unable_to_inspect` with reason
// `too-large-to-scan` so the user sees an honest "couldn't inspect"
// rather than a false clean. This is separate from the 20 MB
// extraction-side `MAX_EXTRACTION_BYTES`: a compact PDF can still
// yield millions of characters of text.
export const MAX_SCAN_CHARS = 2_000_000

/**
 * Run extraction + detection on every file with bounded concurrency
 * and return a `FileInspection`. At most `MAX_CONCURRENT_EXTRACTIONS`
 * files are in flight at once, so aggregate memory is bounded by
 * `MAX_CONCURRENT_EXTRACTIONS × MAX_EXTRACTION_BYTES` regardless of
 * how many files the user dropped.
 *
 * Never rejects. Per-file failure modes:
 *   • Extraction failure — file's `extraction.status` is already
 *     `'unable_to_inspect'`; detection is skipped and the scan
 *     state carries the extraction reason.
 *   • Detection failure (e.g. a rule regex hitting an OOM or an
 *     unexpected exception on an adversarial input) — we downgrade
 *     that file's extraction to `'unable_to_inspect'` with reason
 *     `'scan-error'` and produce an unable-to-inspect scan state.
 *     The remaining files continue.
 *   • Text over `MAX_SCAN_CHARS` — same downgrade with reason
 *     `'too-large-to-scan'`. Explicitly not truncated-and-scanned
 *     because a truncated scan that returns "clean" would be a
 *     false negative.
 */
export async function inspectFiles(files: readonly File[]): Promise<FileInspection> {
  const perFile: FileInspectionEntry[] = new Array(files.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < files.length) {
      const index = next++
      const file = files[index] as File
      perFile[index] = await inspectOne(file)
    }
  }
  const poolSize = Math.min(MAX_CONCURRENT_EXTRACTIONS, files.length)
  await Promise.all(Array.from({ length: poolSize }, worker))
  return { perFile, aggregate: aggregateScanResults(perFile.map((e) => e.scan)) }
}

async function inspectOne(file: File): Promise<FileInspectionEntry> {
  const meta: FileMeta = { file, name: file.name, size: file.size, type: file.type }
  const extraction = await extractText(file)

  // Size guard runs BEFORE detection on extracted text. A document
  // whose extracted text exceeds the scan cap becomes
  // `unable_to_inspect / too-large-to-scan` — we mutate the
  // extraction so downstream state (and the scan-result carrier) is
  // consistent with what we chose not to scan.
  if (extraction.status === 'extracted' && extraction.text.length > MAX_SCAN_CHARS) {
    const downgraded: ExtractionResult = {
      status: 'unable_to_inspect',
      text: '',
      reason: 'too-large-to-scan',
      meta: extraction.meta,
    }
    return {
      meta,
      extraction: downgraded,
      findings: [],
      scan: scanResultFor(downgraded, null),
    }
  }

  if (extraction.status !== 'extracted') {
    // Empty (parsed cleanly but no text) or unable_to_inspect — no
    // detection to run. Both cases yield `findings: []`; the scan
    // helper produces the right state (`clean` for empty, unable
    // for unable_to_inspect with the extraction reason carried).
    return {
      meta,
      extraction,
      findings: [],
      scan: scanResultFor(extraction, null),
    }
  }

  let detection: DetectionResult
  try {
    detection = detectDetailed(extraction.text)
  } catch (err) {
    // The V1.1 detector is well-tested on paste-sized inputs, but
    // document text is a new distribution. A single hostile file
    // must not crash the whole hold pool.
    console.error('[AI Leak Guard] doc-scan error:', err)
    const downgraded: ExtractionResult = {
      status: 'unable_to_inspect',
      text: '',
      reason: 'scan-error',
      meta: extraction.meta,
    }
    return {
      meta,
      extraction: downgraded,
      findings: [],
      scan: scanResultFor(downgraded, null),
    }
  }

  return {
    meta,
    extraction,
    findings: detection.findings,
    scan: scanResultFor(extraction, detection),
  }
}

/**
 * Re-export of the V1.1 `isMaskable` predicate so downstream callers
 * (A4 modal, A5 event log) can gate on the same "counts as sensitive"
 * rule the inspector uses. Prefer this over reaching into the
 * detector engine directly.
 */
export { isMaskable }
