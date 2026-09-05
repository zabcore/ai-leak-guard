// V1.3 M5 — the self-test RUNNER (content-script side).
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
//   • it bails with DRAFT_PRESENT if the composer is non-empty;
//   • it clears the synthetic text on every exit path;
//   • the only modal interaction is `cancelModal()` (return-to-edit).

import { SYNTHETIC_TEXT, type SelfTestCode, type SelfTestResultKind } from '../../shared/self-test'

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
  /** Current composer text (for the empty-draft guard). */
  readonly readText: (el: HTMLElement) => string
  /** Insert text into the composer (site adapter's real insert path). */
  readonly insert: (el: HTMLElement, text: string) => void
  /** Clear the composer (restore empty). Called on every exit. */
  readonly clear: (el: HTMLElement) => void
  /** Fire the REAL send intent (dispatch the Enter the adapter intercepts). Returns `event.defaultPrevented`. */
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

/**
 * Run the self-test. Resolves with a metadata-only report. Never throws
 * into the caller; never submits.
 */
export async function runSelfTest(deps: SelfTestRunnerDeps): Promise<SelfTestRunReport> {
  // 1. Resolve the composer (a fresh tab may still be loading).
  const composer = await pollUntil(() => deps.getComposer(), deps.composerTimeoutMs, deps)
  if (composer === null) return report('fail', 'NO_COMPOSER', 0, 0, 0)

  // Never touch an existing draft — protect anything the user typed.
  if (deps.readText(composer).trim().length > 0) {
    return report('fail', 'DRAFT_PRESENT', 1, 0, 0)
  }

  // 2. Insert synthetic PHI into the empty composer.
  deps.insert(composer, SYNTHETIC_TEXT)

  // 3. Fire the REAL send intent and confirm interception took the send.
  let prevented = false
  try {
    prevented = deps.dispatchSend(composer)
  } catch {
    prevented = false
  }
  if (!prevented) {
    deps.clear(composer)
    // Interception didn't fire — submit protection isn't active here.
    return report('unsupported', 'NO_INTERCEPT', 1, 0, 0)
  }

  // 4. Wait for the warning modal to appear.
  const modalUp = await pollUntil(
    () => (deps.isModalOpen() ? true : null),
    deps.modalTimeoutMs,
    deps,
  )
  if (modalUp === null) {
    deps.clear(composer)
    return report('fail', 'NO_MODAL', 1, 1, 0)
  }

  // 5. AUTO-CANCEL (return-to-edit). NEVER resume. Then clear the
  //    synthetic text. Give the cancel a microtask/tick to settle so the
  //    core lands on RETURNED_TO_EDIT before we wipe the composer.
  deps.cancelModal()
  await deps.sleep(0)
  deps.clear(composer)
  return report('confirmed', 'OK', 1, 1, 1)
}
