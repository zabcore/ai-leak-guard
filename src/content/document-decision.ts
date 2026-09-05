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
import { appendEvent, type AlgAction, type AlgEvent } from '../shared/event-log'
import {
  openDocumentModal,
  type DocumentModalController,
  type DocumentModalOutcome,
} from './document-modal'
import {
  markDocPending,
  settleDoc,
  markDocAcknowledged,
  clearDoc,
} from './submit/document-gate'

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
  /**
   * Site adapter id used by the metadata event log (see
   * `src/shared/event-log.ts`). Passed in by the caller — the
   * decision helper is site-agnostic on its own, but the log needs
   * a per-event site label so the popup can render a per-site
   * breakdown. Empty string skips logging.
   */
  readonly logSiteId: string
  /**
   * Best-effort event-log seam. Tests inject a spy; production uses
   * the real `appendEvent`. NEVER throws into the flow.
   */
  readonly logEvent: (event: AlgEvent) => void
}

const defaultDeps: DocumentDecisionDeps = {
  openModal: openDocumentModal,
  setTimer: (fn, ms) => setTimeout(fn, ms) as unknown as number,
  clearTimer: (id) => clearTimeout(id),
  flickerDelayMs: FLICKER_DELAY_MS,
  logSiteId: '',
  logEvent: (event) => {
    // Best-effort: `appendEvent` is itself never-throws, but we
    // still guard here so a synchronous seam swap in a test can't
    // punch through into the flow.
    try {
      void appendEvent(event)
    } catch {
      // Deliberately swallowed.
    }
  },
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
    /**
     * Site adapter id for the metadata event log (empty string
     * skips logging). Content-script callers pass `adapter.id`;
     * tests default to `''` so the log stays silent unless
     * explicitly exercised.
     */
    readonly siteId?: string
    /**
     * V1.3 M4 — the submit-adapter composer key for this site
     * ('chatgpt-composer' etc.). When present, this helper publishes
     * the attach-time inspection lifecycle to the document coordination
     * gate so the send-time scan can reconcile a flagged attachment
     * with typed text. Omitted (tests / non-submit callers) → no gate
     * writes, behaviour byte-identical to V1.2.
     */
    readonly composerKey?: string
    readonly deps?: Partial<DocumentDecisionDeps>
  },
): Promise<DocumentModalOutcome> {
  const deps: DocumentDecisionDeps = {
    ...defaultDeps,
    ...(opts.deps ?? {}),
    // `siteId` on opts wins over any `deps.logSiteId` so the caller
    // that owns the adapter (content-script index.ts) can hand it
    // through without also touching `deps`.
    logSiteId: opts.siteId ?? opts.deps?.logSiteId ?? defaultDeps.logSiteId,
  }

  // V1.3 M4 — publish the inspection lifecycle to the document
  // coordination gate so the send-time scan can reconcile this
  // attachment with typed text. Guarded on `composerKey` so non-submit
  // callers and tests are unaffected. All gate ops are in-memory,
  // metadata-only, and never throw into the flow.
  const composerKey = opts.composerKey
  if (composerKey !== undefined) markDocPending(composerKey)

  // Metadata-only event log helper. Reuses the already-computed
  // aggregate (never re-scans, never touches file content) and
  // stays best-effort — a storage failure MUST NOT deny the
  // upload. `logSiteId === ''` (production content script hadn't
  // wired it yet, or a test seam) skips the log entirely.
  const log = (action: AlgAction, aggregate: AggregateScanResult | null): void => {
    if (deps.logSiteId === '') return
    try {
      deps.logEvent({
        ts: Date.now(),
        site: deps.logSiteId,
        eventType: 'document',
        action,
        categories: aggregate?.categories ?? [],
        count: aggregate?.totalMaskable ?? 0,
        hadCriticalOrHigh: aggregate?.anyCriticalOrHigh ?? false,
      })
    } catch {
      // Never let the log break the flow.
    }
  }

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
      // button is hidden during scanning). The attachment never
      // landed, so drop any pending gate state — a send must not wait
      // on (or warn about) a file the user just cancelled.
      if (composerKey !== undefined) clearDoc(composerKey)
      log('cancelled', null)
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
    // Gate: a clean attachment needs no send-time decision.
    if (composerKey !== undefined) settleDoc(composerKey, { status: 'clean' })
    log('auto-cleared', aggregate)
    return 'upload-anyway'
  }

  if (aggregate.state === 'sensitive') {
    // Gate: settle to 'detected' with the metadata-only summary BEFORE
    // the user decides, so a concurrent send sees the terminal state.
    if (composerKey !== undefined) {
      settleDoc(composerKey, {
        status: 'detected',
        summary: {
          categories: aggregate.categories,
          count: aggregate.totalMaskable,
          hasCriticalOrHigh: aggregate.anyCriticalOrHigh,
        },
        fileCount: inspection.perFile.length,
      })
    }
    const modal = pickOrOpenModal(deps, opts.opener, scanningModal, cancelledDuringScanning)
    modal.showSensitive({
      fileCount: inspection.perFile.length,
      totalMaskable: aggregate.totalMaskable,
      categories: aggregate.categories,
      hasCriticalOrHigh: aggregate.anyCriticalOrHigh,
    })
    const outcome = await modal.outcome
    // Gate: 'upload-anyway' at attach acknowledges this inspection so a
    // later send doesn't re-warn the SAME unchanged file; 'cancel'
    // means the file never attached → drop it.
    if (composerKey !== undefined) {
      if (outcome === 'upload-anyway') markDocAcknowledged(composerKey)
      else clearDoc(composerKey)
    }
    log(outcome === 'upload-anyway' ? 'uploaded-anyway' : 'cancelled', aggregate)
    return outcome
  }

  // aggregate.state === 'unable_to_inspect'
  const reason = firstUnableReason(inspection)
  // Gate: an uninspectable attachment is NEVER auto-safe at send.
  if (composerKey !== undefined) {
    settleDoc(composerKey, {
      status: 'unable-to-inspect',
      fileCount: inspection.perFile.length,
    })
  }
  const modal = pickOrOpenModal(deps, opts.opener, scanningModal, cancelledDuringScanning)
  modal.showUnable({
    fileCount: inspection.perFile.length,
    reason,
  })
  const outcome = await modal.outcome
  if (composerKey !== undefined) {
    if (outcome === 'upload-anyway') markDocAcknowledged(composerKey)
    else clearDoc(composerKey)
  }
  // On unable, category/count intentionally stay empty/zero — there
  // was no successful detection to attribute the release to. The
  // separate `unable-to-inspect` action + reason (captured by the
  // modal for the user) is the honest signal, not a fabricated
  // categories list.
  log(outcome === 'upload-anyway' ? 'unable-to-inspect' : 'cancelled', null)
  return outcome
}

/**
 * Prefer the already-painted scanning modal (upgrade in place, keep
 * the user's focus/state), otherwise open a fresh one. Extracted
 * because the sensitive + unable branches picked between these the
 * same way — a copy-paste that started to drift when the event-log
 * hookup added a `const outcome = await modal.outcome`.
 */
function pickOrOpenModal(
  deps: DocumentDecisionDeps,
  opener: Element | null,
  scanning: DocumentModalController | null,
  cancelled: boolean,
): DocumentModalController {
  if (scanning !== null && !cancelled) return scanning
  return deps.openModal({ opener })
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
