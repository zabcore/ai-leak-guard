// V1.3.1 §Growth Loop — PURE eligibility, dedup counting, and state reducers.
//
// Nothing in this file touches chrome, the DOM, or the clock directly: every
// function takes its inputs (including `now`) as arguments and returns plain
// data. That makes the whole policy unit-testable with a fake clock and
// hand-built state, and keeps the growth loop fully independent of the
// protection code.

import type { AlgAction } from '../shared/event-log'
import {
  DEDUP_WINDOW_MS,
  DISMISS_SUPPRESS_MS,
  INSTALL_MIN_AGE_MS,
  KILL_SWITCH_WINDOW_MS,
  MIN_PROTECTION_EVENTS,
  PERMANENT_DISMISS_COUNT,
  PROBLEM_REPORT_SUPPRESS_MS,
  SELF_TEST_FAIL_WINDOW_MS,
  UNABLE_TO_INSPECT_WINDOW_MS,
} from './constants'
import type {
  CountableEvent,
  EligibilityDecision,
  EligibilityInputs,
  EligibilityReason,
  GrowthState,
} from './types'

/**
 * Actions that represent a REAL warning/decision the user acted on — the
 * signal that the extension did something useful for them.
 *
 * Counts:   protected, cancelled, as-is, uploaded-anyway
 * Excluded: auto-cleared (clean scan, no warning),
 *           unable-to-inspect (incomplete protection)
 */
const COUNTING_ACTIONS: ReadonlySet<AlgAction> = new Set<AlgAction>([
  'protected',
  'cancelled',
  'as-is',
  'uploaded-anyway',
])

export function isCountingAction(action: AlgAction): boolean {
  return COUNTING_ACTIONS.has(action)
}

/**
 * The "risk shape" of a counting event: site + sorted categories + count +
 * hadCriticalOrHigh. Two events with the same shape close together are the
 * same content being inspected twice (e.g. paste then send of one clipboard).
 * Metadata only — no values are read.
 */
function riskShapeKey(e: CountableEvent): string {
  const cats = [...e.categories].sort().join(',')
  return `${e.site}|${cats}|${e.count}|${e.hadCriticalOrHigh ? 1 : 0}`
}

/**
 * Count successful protection events from the metadata event log, collapsing
 * duplicate inspection of the same content.
 *
 * Events are expected oldest-first (the log's stored order). A counting event
 * is skipped when the IMMEDIATELY-PRECEDING COUNTED event has the same risk
 * shape within `DEDUP_WINDOW_MS`; the reference stays the last event we
 * actually counted, so three identical events in a burst collapse to one
 * while a genuine later repeat (outside the window) still counts.
 */
export function countProtectionEvents(
  events: readonly CountableEvent[],
  windowMs: number = DEDUP_WINDOW_MS,
): number {
  let count = 0
  let last: { ts: number; key: string } | null = null
  for (const e of events) {
    if (!isCountingAction(e.action)) continue
    const key = riskShapeKey(e)
    if (last !== null && last.key === key && e.ts - last.ts <= windowMs && e.ts - last.ts >= 0) {
      // Duplicate inspection of the same content — skip, keep the reference.
      continue
    }
    count += 1
    last = { ts: e.ts, key }
  }
  return count
}

/**
 * Decide whether the growth prompt may appear automatically. All eligibility
 * gates AND all failure-suppression signals must pass. The failure signals are
 * checked FIRST — a user having a bad experience must see support, not a
 * review request, even if they'd otherwise be eligible.
 */
export function computeEligibility(inputs: EligibilityInputs): EligibilityDecision {
  const { now, state } = inputs

  const no = (reason: EligibilityReason): EligibilityDecision => ({ eligible: false, reason })

  // ── Completion / permanent suppression (independent of failure signals) ──
  if (state.reviewClicked) return no('already-completed')
  if (state.permanentlySuppressed) return no('permanently-suppressed')

  // ── Failure suppression — bad experience → support, not a review ask ──
  if (
    inputs.selfTest !== null &&
    inputs.selfTest.result === 'fail' &&
    withinWindow(now, inputs.selfTest.tsMs, SELF_TEST_FAIL_WINDOW_MS)
  ) {
    return no('suppressed-self-test-fail')
  }
  if (
    inputs.killSwitch !== null &&
    withinWindow(now, inputs.killSwitch.ts, KILL_SWITCH_WINDOW_MS)
  ) {
    return no('suppressed-kill-switch')
  }
  if (inputs.currentSiteUnsupported) {
    return no('suppressed-unsupported-site')
  }
  if (
    state.lastProblemReportAt !== null &&
    withinWindow(now, state.lastProblemReportAt, PROBLEM_REPORT_SUPPRESS_MS)
  ) {
    return no('suppressed-problem-report')
  }
  if (
    inputs.mostRecentEvent !== null &&
    inputs.mostRecentEvent.action === 'unable-to-inspect' &&
    withinWindow(now, inputs.mostRecentEvent.ts, UNABLE_TO_INSPECT_WINDOW_MS)
  ) {
    return no('suppressed-unable-to-inspect')
  }

  // ── Dismissal window ──
  if (state.dismissedUntil !== null && now < state.dismissedUntil) {
    return no('dismissed-recently')
  }

  // ── Positive eligibility gates ──
  if (state.installDate <= 0 || now - state.installDate < INSTALL_MIN_AGE_MS) {
    return no('not-installed-long-enough')
  }
  if (inputs.protectionEventCount < MIN_PROTECTION_EVENTS) {
    return no('too-few-protection-events')
  }

  return { eligible: true, reason: 'eligible' }
}

/** True when `ts` is a finite past-or-now timestamp within `windowMs` of `now`. */
function withinWindow(now: number, ts: number, windowMs: number): boolean {
  if (!Number.isFinite(ts)) return false
  const age = now - ts
  return age >= 0 && age <= windowMs
}

// ── State reducers (pure — return a fresh GrowthState) ─────────────────────

/** A brand-new state for a fresh install; `installDate` set to `now`. */
export function freshState(now: number): GrowthState {
  return {
    installDate: now,
    firstEligibleAt: null,
    lastShownAt: null,
    dismissCount: 0,
    dismissedUntil: null,
    reviewClicked: false,
    shareClicked: false,
    permanentlySuppressed: false,
    lastProblemReportAt: null,
  }
}

/** Set `installDate` on first popup open if it is unset (0 / negative). */
export function ensureInstallDate(state: GrowthState, now: number): GrowthState {
  if (state.installDate > 0) return state
  return { ...state, installDate: now }
}

/** Record the first moment the prompt became eligible (idempotent). */
export function markEligible(state: GrowthState, now: number): GrowthState {
  if (state.firstEligibleAt !== null) return state
  return { ...state, firstEligibleAt: now }
}

/** Record that the card was shown to the user. */
export function markShown(state: GrowthState, now: number): GrowthState {
  return { ...state, lastShownAt: now }
}

/**
 * Apply a "Not now" dismissal: bump the count, set the 30-day window, and on
 * the second dismissal make suppression permanent.
 */
export function applyDismiss(state: GrowthState, now: number): GrowthState {
  const dismissCount = state.dismissCount + 1
  return {
    ...state,
    dismissCount,
    dismissedUntil: now + DISMISS_SUPPRESS_MS,
    permanentlySuppressed:
      state.permanentlySuppressed || dismissCount >= PERMANENT_DISMISS_COUNT,
  }
}

/** The review CTA was clicked — completes the prompt (never nag again). */
export function applyReviewClicked(state: GrowthState): GrowthState {
  return { ...state, reviewClicked: true }
}

/** The referral CTA was used (does not complete the prompt). */
export function applyShareClicked(state: GrowthState): GrowthState {
  return { ...state, shareClicked: true }
}

/** Record that the user proceeded through the §E problem report. */
export function applyProblemReport(state: GrowthState, now: number): GrowthState {
  return { ...state, lastProblemReportAt: now }
}

/**
 * Re-enable the prompt from the "Support AI Leak Guard" link: clear permanent
 * suppression and the dismissal window, and reset the dismiss count so the
 * user gets a fresh cycle. `reviewClicked` is intentionally preserved — a
 * completed review is not undone.
 */
export function applyReEnable(state: GrowthState): GrowthState {
  return {
    ...state,
    permanentlySuppressed: false,
    dismissedUntil: null,
    dismissCount: 0,
  }
}
