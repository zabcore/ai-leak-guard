// V1.3.1 §Growth Loop — types for the local review/referral prompt.
//
// STORAGE IS METADATA ONLY. There is deliberately no field that could hold
// page content, prompt text, filenames, matched values, or any sensitive
// value — only timestamps, counts, and booleans. The `growthPrompt`
// storage key persists exactly the `GrowthState` shape below.

import type { AlgAction } from '../shared/event-log'

/**
 * Persisted growth-loop state (`chrome.storage.local` key `growthPrompt`).
 *
 * `successfulProtectionCount` is intentionally NOT stored — the count is
 * DERIVED read-side from the metadata event log (see `countProtectionEvents`)
 * so nothing is written into the protection hot path. The spec allows either;
 * deriving keeps the protection code untouched.
 */
export interface GrowthState {
  /** ms epoch; set on first popup open if unset. */
  readonly installDate: number
  /** ms epoch the prompt first became eligible (best-effort, informational). */
  readonly firstEligibleAt: number | null
  /** ms epoch the card was last actually shown. */
  readonly lastShownAt: number | null
  /** Count of "Not now" dismissals. */
  readonly dismissCount: number
  /** ms epoch until which the prompt stays dismissed. */
  readonly dismissedUntil: number | null
  /** The review CTA was clicked — the prompt is complete, never nag again. */
  readonly reviewClicked: boolean
  /** The referral CTA was used at least once (does not complete the prompt). */
  readonly shareClicked: boolean
  /** Second dismissal → permanent, until re-enabled via the Support link. */
  readonly permanentlySuppressed: boolean
  /** ms epoch the user last proceeded through the §E problem report. */
  readonly lastProblemReportAt: number | null
}

/** A minimal event projection the dedup/count logic needs (metadata only). */
export interface CountableEvent {
  readonly ts: number
  readonly site: string
  readonly action: AlgAction
  readonly categories: readonly string[]
  readonly count: number
  readonly hadCriticalOrHigh: boolean
}

/**
 * Everything `computeEligibility` needs, fully resolved by the caller. Kept as
 * plain data (no chrome/DOM handles) so eligibility is a pure function that a
 * unit test drives with a fake clock and hand-built inputs.
 */
export interface EligibilityInputs {
  readonly now: number
  readonly state: GrowthState
  /** Derived count of successful protection events (post-dedup). */
  readonly protectionEventCount: number
  /** Most recent self-test result, if one is still present in storage. */
  readonly selfTest: { readonly result: string; readonly tsMs: number } | null
  /** Submit kill switch record, if set. */
  readonly killSwitch: { readonly ts: number } | null
  /**
   * True when the popup's active tab is on a surface with no `supported`
   * channel (or is not an in-scope site at all). The activity page passes
   * `false` — it is a deliberate destination, not a live browsing surface.
   */
  readonly currentSiteUnsupported: boolean
  /** The most recent activity event (any action), if any. */
  readonly mostRecentEvent: { readonly action: AlgAction; readonly ts: number } | null
}

/** Why the prompt is or isn't shown — useful for tests and reasoning. */
export type EligibilityReason =
  | 'eligible'
  | 'not-installed-long-enough'
  | 'too-few-protection-events'
  | 'already-completed'
  | 'permanently-suppressed'
  | 'dismissed-recently'
  | 'suppressed-self-test-fail'
  | 'suppressed-kill-switch'
  | 'suppressed-unsupported-site'
  | 'suppressed-problem-report'
  | 'suppressed-unable-to-inspect'

export interface EligibilityDecision {
  readonly eligible: boolean
  readonly reason: EligibilityReason
}
