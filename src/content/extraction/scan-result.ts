// V1.2 A3 per-file + aggregate scan-result state.
//
// A2 gave every held file an `ExtractionResult`. A3 runs the V1.1
// detector over that text and rolls the outcome into a small
// `DocScanResult` shape so A4's warning UX can render a headline
// summary without re-computing categories / severities. This module
// is deliberately UI-free — it produces a value, nothing more.
//
// The single "counts as sensitive" gate is `isMaskable` (from the
// V1.1 engine). Clinical-context / LOW findings (ICD/CPT alone,
// medication mentions, etc.) never mask on their own on the paste
// path; the same must hold here, so `state === 'sensitive'` requires
// at least one maskable finding — not just any finding.
//
// Metadata-only discipline. The scan RESULT (state / counts /
// categories / severity flag) is safe to log or forward to A5.
// `Finding.value` (the matched text) must NEVER leave memory — this
// module deliberately does not expose it.

import type { DetectionResult, Finding } from '../../detector/types'
import { DetectorCategory } from '../../detector/types'
import { isMaskable } from '../../detector/engine'
import type { ExtractionResult } from './extract'

export type DocScanState = 'clean' | 'sensitive' | 'unable_to_inspect'

export interface DocScanResult {
  readonly state: DocScanState
  /** Count of findings that pass `isMaskable`. Never includes bare
   *  clinical-context signals. */
  readonly maskableCount: number
  /** Distinct taxonomy categories among the maskable findings. */
  readonly categories: readonly DetectorCategory[]
  /** Convenience flag mirroring `detectDetailed().hasCriticalOrHigh`. */
  readonly hasCriticalOrHigh: boolean
  /** Present when `state === 'unable_to_inspect'`; explains why. */
  readonly reason?: string
}

/**
 * Build a per-file `DocScanResult` from an extraction outcome and
 * (optionally) the detector's output over the extracted text.
 *
 * `detection` is `null` when we did NOT run the detector — either
 * the extraction failed (`unable_to_inspect`) or produced an empty
 * text (`empty`). In both cases the file is not sensitive by
 * construction; we just carry forward the extraction reason for the
 * unable case so A4 can render the correct copy.
 */
export function scanResultFor(
  extraction: ExtractionResult,
  detection: DetectionResult | null,
): DocScanResult {
  if (extraction.status === 'unable_to_inspect') {
    return {
      state: 'unable_to_inspect',
      maskableCount: 0,
      categories: [],
      hasCriticalOrHigh: false,
      reason: extraction.reason,
    }
  }
  if (extraction.status === 'empty' || detection === null) {
    return {
      state: 'clean',
      maskableCount: 0,
      categories: [],
      hasCriticalOrHigh: false,
    }
  }
  const maskable = detection.findings.filter(isMaskable)
  if (maskable.length === 0) {
    return {
      state: 'clean',
      maskableCount: 0,
      categories: [],
      hasCriticalOrHigh: false,
    }
  }
  return {
    state: 'sensitive',
    maskableCount: maskable.length,
    categories: uniqueCategories(maskable),
    hasCriticalOrHigh: detection.hasCriticalOrHigh,
  }
}

export interface AggregateScanResult {
  /** Rolled-up state across the drop: `sensitive` beats `unable_to_inspect`
   *  beats `clean`. Callers rendering a headline pick their copy on this. */
  readonly state: DocScanState
  /** Sum of `maskableCount` across every file. */
  readonly totalMaskable: number
  /** Distinct categories across every file's maskable findings. */
  readonly categories: readonly DetectorCategory[]
  /** True when ANY file's detection carried a critical/high finding. */
  readonly anyCriticalOrHigh: boolean
  /** How many files ended in each state. `sensitive + clean + unable === total`. */
  readonly perStateCounts: {
    readonly sensitive: number
    readonly clean: number
    readonly unable: number
  }
}

/**
 * Fold a per-file `DocScanResult[]` into a single headline. Order:
 * `sensitive` (any file sensitive) > `unable_to_inspect` (any file
 * unable, none sensitive) > `clean` (all files clean, possibly
 * including `empty`).
 */
export function aggregateScanResults(perFile: readonly DocScanResult[]): AggregateScanResult {
  let sensitive = 0
  let clean = 0
  let unable = 0
  let totalMaskable = 0
  let anyCriticalOrHigh = false
  const categorySet = new Set<DetectorCategory>()
  for (const entry of perFile) {
    if (entry.state === 'sensitive') sensitive += 1
    else if (entry.state === 'unable_to_inspect') unable += 1
    else clean += 1
    totalMaskable += entry.maskableCount
    if (entry.hasCriticalOrHigh) anyCriticalOrHigh = true
    for (const c of entry.categories) categorySet.add(c)
  }
  const state: DocScanState =
    sensitive > 0 ? 'sensitive' : unable > 0 ? 'unable_to_inspect' : 'clean'
  return {
    state,
    totalMaskable,
    categories: [...categorySet],
    anyCriticalOrHigh,
    perStateCounts: { sensitive, clean, unable },
  }
}

function uniqueCategories(findings: readonly Finding[]): DetectorCategory[] {
  const set = new Set<DetectorCategory>()
  for (const f of findings) {
    if (f.category) set.add(f.category)
  }
  return [...set]
}
