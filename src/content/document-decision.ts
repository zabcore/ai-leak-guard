// V1.2 A4 shared decision helper for the document-protection flow.
//
// Both hold paths funnel through this function so their behavior
// cannot drift:
//
//   • `document-flow.ts` — change / drop / paste (isolated world)
//   • `fsa-isolated.ts`  — ChatGPT `showOpenFilePicker` picker path
//
// Given a pending `inspectFiles` promise and an opener element, this
// helper produces the user's decision (`'upload-anyway'` /
// `'cancel'`) after routing on the aggregate scan state:
//
//   clean               → auto-proceed silently: resolve
//                         `'upload-anyway'` with NO modal shown. The
//                         caller does its usual release step; the user
//                         never sees a warning they don't need.
//   sensitive           → open the modal in the sensitive view with
//                         `totalMaskable` + friendly category chips +
//                         a critical-or-high emphasis; primary is
//                         [Upload anyway].
//   unable_to_inspect   → open the modal in the honest "we couldn't
//                         read this file to check it" view with a
//                         reason-aware sub-line; primary is still
//                         [Upload anyway].
//
// Anti-flicker. Extraction can take up to `EXTRACTION_TIMEOUT_MS`
// per file; a scanning-then-flash-close on a paste-sized file would
// look broken. The helper waits `FLICKER_DELAY_MS` before painting
// the scanning view — if inspection resolves faster it goes straight
// to the terminal state (or to auto-proceed on clean). The user can
// cancel the scan the moment the scanning view appears.

import type { FileInspection } from './file-inspector'
import type { AggregateScanResult } from './extraction/scan-result'
import type { ExtractionReason } from './extraction/extract'
import {
  openDocumentModal,
  type DocumentModalController,
  type DocumentModalOutcome,
} from './document-modal'

/**
 * How long to wait before painting the scanning view. Chosen so
 * paste-sized inputs (a few KB — inspection usually resolves in
 * <50 ms) go straight from "hold intercepted" to "modal shown for
 * result / auto-release", but a slow multi-page PDF flips to the
 * scanning spinner well before the user thinks the click was lost.
 */
export const FLICKER_DELAY_MS = 250

/**
 * Injectable seams so unit tests can drive the helper without
 * touching the DOM. Production uses `openDocumentModal` directly.
 */
export interface DocumentDecisionDeps {
  readonly openModal: (opts: { readonly opener: Element | null }) => DocumentModalController
  /** Injectable for fake timers in tests. Defaults to `setTimeout`. */
  readonly setTimer: (fn: () => void, ms: number) => number
  readonly clearTimer: (id: number) => void
  /** Anti-flicker delay in ms. Tests override to 0 or a large value. */
  readonly flickerDelayMs: number
}

const defaultDeps: DocumentDecisionDeps = {
  openModal: openDocumentModal,
  setTimer: (fn, ms) => setTimeout(fn, ms) as unknown as number,
  clearTimer: (id) => clearTimeout(id),
  flickerDelayMs: FLICKER_DELAY_MS,
}

/**
 * Turn a pending `FileInspection` into a decision, opening the modal
 * only when needed. Never throws — an inspection failure would show
 * the unable-to-inspect view, but `inspectFiles` is itself
 * documented never-throws (per-file failures land as
 * `unable_to_inspect`) so this helper's promise stays a clean
 * `'upload-anyway' | 'cancel'`.
 *
 * On `clean` the modal is never opened, so `isDocumentModalOpen()`
 * stays false — the change/paste/drop handlers' "another modal is
 * open, drop this event" gate is not affected.
 */
export async function resolveDocumentDecision(
  inspectionPromise: Promise<FileInspection>,
  opts: {
    readonly opener: Element | null
    readonly deps?: Partial<DocumentDecisionDeps>
  },
): Promise<DocumentModalOutcome> {
  const deps: DocumentDecisionDeps = { ...defaultDeps, ...(opts.deps ?? {}) }

  // Race inspection against the anti-flicker timer. The winner
  // decides whether we ever paint the scanning view.
  let scanningModal: DocumentModalController | null = null
  let cancelledDuringScanning = false

  let timerId: number | null = null
  const timerFired = new Promise<'timer'>((resolve) => {
    timerId = deps.setTimer(() => {
      timerId = null
      resolve('timer')
    }, deps.flickerDelayMs)
  })
  const inspectionSettled: Promise<'inspection'> = inspectionPromise.then(() => 'inspection')
  const winner = await Promise.race([timerFired, inspectionSettled])

  if (winner === 'timer') {
    // Inspection is still pending. Paint the scanning view so the
    // user gets feedback; race the inspection against the user's
    // cancel.
    scanningModal = deps.openModal({ opener: opts.opener })
    const cancelDuringScanning = scanningModal.outcome.then((outcome) => {
      cancelledDuringScanning = true
      return outcome
    })
    const raceResult = await Promise.race([cancelDuringScanning, inspectionSettled])
    if (raceResult !== 'inspection') {
      // User hit Cancel / Escape / × / backdrop while the scan was
      // running. The modal has already resolved; we forward the
      // outcome (always `'cancel'` in this branch since the primary
      // button is hidden during scanning).
      return raceResult
    }
  } else {
    // Inspection resolved inside the flicker window — we still need
    // to clear the pending scanning timer so the modal is never
    // painted after we've already routed.
    if (timerId !== null) deps.clearTimer(timerId)
  }

  // Both branches reach here only after `inspectionSettled` has
  // resolved, so the underlying promise is settled and awaiting it
  // is synchronous.
  const inspection: FileInspection = await inspectionPromise
  const aggregate = inspection.aggregate

  if (aggregate.state === 'clean') {
    // Auto-proceed. If a scanning modal was painted (slow scan that
    // ended up clean), close it as `'upload-anyway'` — the user
    // shouldn't get a cancel result they didn't ask for.
    if (scanningModal !== null && !cancelledDuringScanning) {
      scanningModal.close('upload-anyway')
    }
    return 'upload-anyway'
  }

  if (aggregate.state === 'sensitive') {
    if (scanningModal !== null && !cancelledDuringScanning) {
      scanningModal.showSensitive({
        fileCount: inspection.perFile.length,
        totalMaskable: aggregate.totalMaskable,
        categories: aggregate.categories,
        hasCriticalOrHigh: aggregate.anyCriticalOrHigh,
      })
      return scanningModal.outcome
    }
    const modal = deps.openModal({ opener: opts.opener })
    modal.showSensitive({
      fileCount: inspection.perFile.length,
      totalMaskable: aggregate.totalMaskable,
      categories: aggregate.categories,
      hasCriticalOrHigh: aggregate.anyCriticalOrHigh,
    })
    return modal.outcome
  }

  // aggregate.state === 'unable_to_inspect'
  const reason = firstUnableReason(inspection)
  if (scanningModal !== null && !cancelledDuringScanning) {
    scanningModal.showUnable({
      fileCount: inspection.perFile.length,
      reason,
    })
    return scanningModal.outcome
  }
  const modal = deps.openModal({ opener: opts.opener })
  modal.showUnable({
    fileCount: inspection.perFile.length,
    reason,
  })
  return modal.outcome
}

/**
 * Pick the `ExtractionReason` used in the unable-view sub-line. When
 * multiple files failed for different reasons, the first one wins —
 * arbitrary but stable, and the copy is honest either way (the user
 * only needs one accurate line to decide). Extracted so tests can
 * cover the fallthrough shapes without going through the modal.
 */
export function firstUnableReason(inspection: FileInspection): ExtractionReason | undefined {
  for (const entry of inspection.perFile) {
    if (entry.scan.state === 'unable_to_inspect') {
      return entry.extraction.reason
    }
  }
  return undefined
}

/**
 * Pure predicate exported for unit tests: what would the helper do
 * with a given aggregate WITHOUT opening a modal? Callers use this
 * when they want to know the branch without paying the modal cost
 * (currently just tests + the aggregate-clean nudge decision in the
 * content script). Never opens UI.
 */
export function aggregateBranch(
  aggregate: AggregateScanResult,
): 'auto-release' | 'sensitive' | 'unable' {
  if (aggregate.state === 'sensitive') return 'sensitive'
  if (aggregate.state === 'unable_to_inspect') return 'unable'
  return 'auto-release'
}
