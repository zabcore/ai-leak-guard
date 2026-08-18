// Release paths and the pass-through-once guard for the V1.2
// document-protection flow.
//
// When the user chooses "Upload anyway", the intercepted files are
// released to the host without inspection. Two strategies, tried in
// order:
//
//   1. **DataTransfer replay on the origin input.** For a change event
//      whose target was a discoverable `<input type="file">`, we build
//      a fresh DataTransfer and assign its FileList back to
//      `input.files`. Some frameworks (React 18 controlled inputs are
//      the notable example) synchronously dispatch a `change` on that
//      assignment — the window-capture listener sees it, consumes the
//      pass-through guard, and hands it to the host. When that
//      happens we MUST NOT dispatch a second synthetic change: the
//      guard is already spent, our second event would be
//      re-intercepted, and the host could end up with two upload
//      requests for one file. So we install a one-shot local listener
//      that tells us whether assignment already fired change, and only
//      dispatch our own change when it did not.
//      Works on ChatGPT / Claude / Perplexity light-DOM inputs (per
//      the A0 matrix); may fail on Gemini's `rich-textarea` shadow
//      root — see per-site notes in docs/ARCHITECTURE.md.
//
//   2. **Pass-through-once fallback.** When DataTransfer replay fails
//      (or the source event was a drop / paste without a discoverable
//      input), we arm a one-shot guard, and the next file event of the
//      matching kind bypasses our interception entirely. Callers that
//      hit this path show a small "Please re-attach to confirm" nudge
//      (A1 keeps the UI minimal — the modal is the placeholder).
//
// Cancel does the mirror: for a change event, clear `input.value` so
// the site sees no selection at all. For drop/paste, there is nothing
// to reset — we already prevented the default and stopped propagation.
//
// This module holds no bytes of user files; it operates on the File
// object references handed to it by the extraction helpers.

import type { ExtractedFiles } from './file-extraction'

// One-shot guard, cleared as soon as the next file event of the
// matching kind is observed OR after a short TTL — whichever comes
// first. A time-bounded guard prevents a stuck flag from leaking a
// future legitimate paste through interception if the user never
// completes the fallback flow.
interface PassThroughArming {
  kind: ExtractedFiles['kind']
  expiresAt: number
}

let arming: PassThroughArming | null = null

const PASS_THROUGH_TTL_MS = 30_000

/**
 * Arm a one-shot pass-through for the next event of `kind`. The next
 * matching event fires natively; the arming is cleared on that event
 * OR when `PASS_THROUGH_TTL_MS` elapses, whichever comes first.
 */
export function armPassThroughOnce(kind: ExtractedFiles['kind']): void {
  arming = { kind, expiresAt: nowMs() + PASS_THROUGH_TTL_MS }
}

/**
 * Should the incoming event of `kind` bypass our interception?
 * Returns true exactly once per arming (and clears the arming), or
 * false when nothing is armed / the arming was for a different kind /
 * the arming has expired.
 */
export function consumePassThroughIfArmed(kind: ExtractedFiles['kind']): boolean {
  if (arming === null) return false
  if (arming.kind !== kind) return false
  if (nowMs() >= arming.expiresAt) {
    arming = null
    return false
  }
  arming = null
  return true
}

/** Test-only: force-clear the guard so cross-test contamination is impossible. */
export function __resetPassThroughForTests(): void {
  arming = null
}

// Extracted so tests can stub time without pulling in a fake-timer
// harness for every consumer of this module. In production it just
// returns `Date.now()`.
function nowMs(): number {
  return Date.now()
}

/**
 * Reset an `<input type="file">` to an empty state so the site
 * observes no selection. Sets `input.value = ''` (the canonical Chrome
 * way to clear a file input), and — belt & suspenders — also clears
 * `input.files` where the setter is supported. Never dispatches an
 * event: the whole point of cancel is that the site sees nothing.
 */
export function clearFileInput(input: HTMLInputElement): void {
  try {
    input.value = ''
  } catch {
    // Some frameworks lock `.value` on file inputs; the DataTransfer
    // path below is the fallback.
  }
  try {
    // Setting `.files` directly requires a DataTransfer object; assigning
    // its `.files` (an empty FileList) clears the selection without
    // dispatching a change. Wrapped in try/catch because a small number
    // of test/browser combos throw here.
    const dt = new DataTransfer()
    input.files = dt.files
  } catch {
    // Ignore — `input.value = ''` was already applied above.
  }
}

export type ReleaseOutcome = 'released' | 'needs-user-reattach'

/**
 * Release the intercepted files back to the host. Prefers a
 * DataTransfer replay on the origin input; if that path is unavailable
 * (drop, paste, or a change whose target we couldn't hold onto), arms
 * the pass-through-once guard and reports `needs-user-reattach` so the
 * caller can prompt the user to re-attach.
 */
export function releaseFiles(state: ExtractedFiles): ReleaseOutcome {
  if (state.kind === 'change' && state.originInput !== null) {
    const ok = replayChangeViaDataTransfer(state.originInput, state.files)
    if (ok) return 'released'
    // Fall through to the re-attach fallback.
  }
  armPassThroughOnce(state.kind)
  return 'needs-user-reattach'
}

function replayChangeViaDataTransfer(input: HTMLInputElement, files: readonly File[]): boolean {
  // Arm the pass-through BEFORE writing to `input.files` — the
  // assignment can synchronously trigger a `change` event on some
  // frameworks (React's controlled-input wrapper is the notable one),
  // and if we haven't armed yet the window-capture listener would
  // re-intercept.
  //
  // If the assignment DOES synchronously dispatch a change, that event
  // consumes the guard on its way through the window-capture listener
  // and is what the host reacts to. We track that via a one-shot local
  // listener; when the flag is set, we skip our own synthetic dispatch
  // to avoid handing the site two upload events (and to avoid our
  // second event being re-intercepted because the guard is now spent).
  let dispatchedByAssignment = false
  const observer = (): void => {
    dispatchedByAssignment = true
  }
  try {
    const dt = new DataTransfer()
    for (const f of files) dt.items.add(f)
    armPassThroughOnce('change')
    input.addEventListener('change', observer, { capture: false, once: true })
    input.files = dt.files
    if (!dispatchedByAssignment) {
      input.dispatchEvent(new Event('change', { bubbles: true, composed: true }))
    }
    return true
  } catch {
    // DataTransfer construction, input.files assignment, or the dispatch
    // can throw in shadow-DOM edge cases (Gemini) or when the browser
    // treats `input.files` as read-only in a given context. Fall back
    // to the pass-through-once flow.
    return false
  } finally {
    input.removeEventListener('change', observer, { capture: false })
  }
}
