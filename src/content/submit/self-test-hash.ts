// V1.3.4 — start the guided self-test from a plain `#alg-selftest` page link.
//
// A SECOND way in alongside the popup signal (not a replacement): a page can
// link a supported site with the `#alg-selftest` hash and the content script
// starts the exact same guided self-test — synthetic data only, empty-composer
// guard, auto-cancel, absolute send safety net all intact. No popup is waiting
// on it, so the in-tab banner shows the outcome.
//
// This module is the small, TESTABLE orchestration: hash matching + a strict
// run-once guard + URL cleanup. The actual run (the heavy adapter/core/modal
// wiring) is INJECTED by the content script so none of it leaks in here.

export const SELF_TEST_HASH = '#alg-selftest'

/**
 * True when `hash` requests the self-test: `#alg-selftest`, matched
 * case-insensitively, with any trailing junk after the token ignored
 * (`#alg-selftest`, `#ALG-SelfTest`, `#alg-selftest?x`, `#alg-selftest/`, a
 * trailing space, …). `#alg-selftest-foo` is NOT a match — the token must end
 * on a non `[a-z0-9-]` boundary so an unrelated longer hash can't trip it.
 */
export function hashRequestsSelfTest(hash: string): boolean {
  const h = hash.toLowerCase()
  if (h === SELF_TEST_HASH) return true
  return h.startsWith(SELF_TEST_HASH) && !/[a-z0-9-]/.test(h.charAt(SELF_TEST_HASH.length))
}

export interface HashTriggerDeps {
  /** Current top-frame hash, e.g. `() => location.hash`. */
  readonly getHash: () => string
  /** Strip the token from the URL (e.g. `history.replaceState` → path+search). */
  readonly stripHash: () => void
  /** Start the guided self-test. Invoked AT MOST ONCE for the tab's lifetime. */
  readonly run: () => void
  /** True only in the top frame; when false, `check()` is a no-op. */
  readonly isTopFrame: () => boolean
}

export interface HashSelfTestTrigger {
  /** Evaluate the hash now; on a first match, strip it and run exactly once. */
  check(): void
  /** True once a run has been started (the run-once state). */
  hasStarted(): boolean
}

/**
 * Build a run-once hash trigger. `check()` is safe to call repeatedly — on the
 * initial load and on every `hashchange` — and starts the run at most once:
 * a re-render or a repeated `hashchange` after the token is consumed is a
 * no-op. The strip is best-effort; the `started` guard is the real guarantee.
 */
export function createHashSelfTestTrigger(deps: HashTriggerDeps): HashSelfTestTrigger {
  let started = false
  const check = (): void => {
    if (started) return
    // Top frame only: a sub-frame without the real composer must not consume
    // the trigger (same guard as the popup-signal path).
    if (!deps.isTopFrame()) return
    if (!hashRequestsSelfTest(deps.getHash())) return
    started = true
    try {
      deps.stripHash()
    } catch {
      // best-effort; `started` already prevents a second run.
    }
    deps.run()
  }
  return { check, hasStarted: () => started }
}
