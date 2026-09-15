// V1.3 M5 / V1.3.3 — the self-test RUNNER (content-script side).
//
// Drives the REAL interception + scan + warning-modal path on SYNTHETIC
// data only, then ALWAYS cancels (return-to-edit). It NEVER calls
// resume / submits. Runs only in a FRESH tab's empty composer (the
// popup opens one), and refuses to run over an existing draft.
//
// The runner is pure orchestration over injected DOM seams so it can be
// unit-tested deterministically AND wired to the real adapter/core/modal
// in production (per §7: exercise the true path, don't re-implement it).
//
// Safety, restated as code contracts:
//   • no `resume` seam exists here — the runner CANNOT submit;
//   • the send itself runs behind an absolute safety net (see
//     `self-test-send.ts`), so even a FAILED interceptor cannot submit —
//     `dispatchSend` reports interception only, never a fall-through send;
//   • it bails with DRAFT_PRESENT if the composer is non-empty;
//   • it EDIT-GUARDS every cleanup (`guardedClear`) — synthetic text is
//     wiped, but anything the user typed during the run is preserved;
//   • the only modal interaction is `cancelModal()` (return-to-edit).
//
// V1.3.3 also runs each identifier case (name / MRN / DOB) INDEPENDENTLY,
// so a single passing detection can't mask another silently breaking.

import { SELF_TEST_CASES, type SelfTestCode, type SelfTestResultKind } from '../../shared/self-test'

export interface SelfTestRunReport {
  readonly result: SelfTestResultKind
  readonly code: SelfTestCode
  readonly composer: 0 | 1
  readonly intercept: 0 | 1
  readonly modal: 0 | 1
}

export interface SelfTestRunnerDeps {
  /** Resolve the site composer (null until it exists / if unsupported). */
  readonly getComposer: () => HTMLElement | null
  /** Current composer text (for the empty-draft guard + edit-guard). */
  readonly readText: (el: HTMLElement) => string
  /** Insert text into the composer (site adapter's real insert path). */
  readonly insert: (el: HTMLElement, text: string) => void
  /** Clear the composer (restore empty). Called ONLY behind the edit-guard. */
  readonly clear: (el: HTMLElement) => void
  /**
   * Fire the REAL send intent behind the safety net (see `self-test-send.ts`).
   * Returns whether the ADAPTER intercepted — never a fall-through send.
   */
  readonly dispatchSend: (el: HTMLElement) => boolean
  /** Is the guard warning modal on screen? (reuse the real open predicate) */
  readonly isModalOpen: () => boolean
  /** Cancel the modal → return-to-edit. NEVER proceed. */
  readonly cancelModal: () => void
  readonly now: () => number
  readonly sleep: (ms: number) => Promise<void>
  readonly composerTimeoutMs: number
  readonly modalTimeoutMs: number
  readonly pollMs?: number
  /**
   * Optional: notified with the text currently injected into the composer
   * (or `null` once it has been cleared). Lets the production wiring keep an
   * unload guard aimed at exactly what's in flight — see `installUnloadGuard`.
   */
  readonly onInjection?: (text: string | null) => void
}

function report(
  result: SelfTestResultKind,
  code: SelfTestCode,
  composer: 0 | 1,
  intercept: 0 | 1,
  modal: 0 | 1,
): SelfTestRunReport {
  return { result, code, composer, intercept, modal }
}

/** Poll `probe` until it returns a non-null value or the deadline passes. */
async function pollUntil<T>(
  probe: () => T | null,
  timeoutMs: number,
  deps: SelfTestRunnerDeps,
): Promise<T | null> {
  const poll = deps.pollMs ?? 25
  const deadline = deps.now() + timeoutMs
  for (;;) {
    const v = probe()
    if (v !== null) return v
    if (deps.now() >= deadline) return null
    await deps.sleep(poll)
  }
}

/** Ops needed to edit-guard the composer, shared by the runner + unload guard. */
export interface GuardedClearOps {
  readonly readText: (el: HTMLElement) => string
  readonly clear: (el: HTMLElement) => void
}

/**
 * Edit-guarded cleanup: clear the composer ONLY if it still holds exactly the
 * synthetic text we injected. If the user typed during the run (the content
 * differs), leave it untouched — never erase user work. Returns whether it
 * cleared. Used on EVERY exit path (success, cancel, timeout, navigation).
 */
export function guardedClear(el: HTMLElement, injected: string, ops: GuardedClearOps): boolean {
  if (ops.readText(el).trim() === injected.trim()) {
    ops.clear(el)
    return true
  }
  return false
}

/**
 * Install a page-unload guard that edit-guard-clears the composer if the page
 * is being torn down mid-run. `getState` returns the live composer and the
 * text currently injected (null when nothing is in flight). Returns a remover.
 */
export function installUnloadGuard(
  win: Pick<Window, 'addEventListener' | 'removeEventListener'>,
  getState: () => { el: HTMLElement | null; injected: string | null },
  ops: GuardedClearOps,
): () => void {
  const onHide = (): void => {
    const { el, injected } = getState()
    if (el !== null && injected !== null) guardedClear(el, injected, ops)
  }
  win.addEventListener('pagehide', onHide)
  return () => win.removeEventListener('pagehide', onHide)
}

/**
 * Run the self-test. Resolves with a metadata-only report. Never throws
 * into the caller; never submits; never erases user work.
 */
export async function runSelfTest(deps: SelfTestRunnerDeps): Promise<SelfTestRunReport> {
  const ops: GuardedClearOps = { readText: deps.readText, clear: deps.clear }

  // 1. Resolve the composer (a fresh tab may still be loading).
  const composer = await pollUntil(() => deps.getComposer(), deps.composerTimeoutMs, deps)
  if (composer === null) return report('fail', 'NO_COMPOSER', 0, 0, 0)

  // Never touch an existing draft — protect anything the user typed.
  if (deps.readText(composer).trim().length > 0) {
    return report('fail', 'DRAFT_PRESENT', 1, 0, 0)
  }

  // 2. Exercise EACH identifier case independently (name / MRN / DOB …).
  for (const testCase of SELF_TEST_CASES) {
    deps.insert(composer, testCase.text)
    deps.onInjection?.(testCase.text)

    // 3. Fire the REAL send (behind the safety net) and confirm interception.
    let prevented = false
    try {
      prevented = deps.dispatchSend(composer)
    } catch {
      prevented = false
    }
    if (!prevented) {
      // Interception didn't fire — submit protection isn't active here. The
      // safety net already blocked any send; just clean up and report.
      guardedClear(composer, testCase.text, ops)
      deps.onInjection?.(null)
      return report('unsupported', 'NO_INTERCEPT', 1, 0, 0)
    }

    // 4. Wait for the warning modal to appear.
    const modalUp = await pollUntil(
      () => (deps.isModalOpen() ? true : null),
      deps.modalTimeoutMs,
      deps,
    )
    if (modalUp === null) {
      guardedClear(composer, testCase.text, ops)
      deps.onInjection?.(null)
      return report('fail', 'NO_MODAL', 1, 1, 0)
    }

    // 5. AUTO-CANCEL (return-to-edit). NEVER resume. Wait for the modal to
    //    fully close before the next case, or the adapter would bail on the
    //    next send ("a guard modal is open") and misreport NO_INTERCEPT.
    deps.cancelModal()
    await deps.sleep(0)
    await pollUntil(() => (deps.isModalOpen() ? null : true), deps.modalTimeoutMs, deps)

    // 6. Edit-guarded cleanup. If the user typed during this case, preserve
    //    their work and stop — interception + modal were already confirmed,
    //    so protection is proven; never inject over what they wrote.
    const cleared = guardedClear(composer, testCase.text, ops)
    if (!cleared) {
      deps.onInjection?.(testCase.text) // still in flight, but preserved
      return report('confirmed', 'OK', 1, 1, 1)
    }
    deps.onInjection?.(null)
  }

  return report('confirmed', 'OK', 1, 1, 1)
}
