// V1.3.1 §Growth Loop — eligibility, dedup counting, and suppression.
//
// Pure-function tests with an injected clock (`now`) and hand-built inputs —
// no chrome, no DOM, no real time.

import { describe, expect, it } from 'vitest'
import {
  computeEligibility,
  countProtectionEvents,
  isCountingAction,
} from '../src/growth/eligibility'
import {
  DEDUP_WINDOW_MS,
  DISMISS_SUPPRESS_MS,
  INSTALL_MIN_AGE_MS,
  KILL_SWITCH_WINDOW_MS,
  MIN_PROTECTION_EVENTS,
  PROBLEM_REPORT_SUPPRESS_MS,
  SELF_TEST_FAIL_WINDOW_MS,
} from '../src/growth/constants'
import type { CountableEvent, EligibilityInputs, GrowthState } from '../src/growth/types'
import type { AlgAction } from '../src/shared/event-log'

const NOW = 1_800_000_000_000

function ev(overrides: Partial<CountableEvent> = {}): CountableEvent {
  return {
    ts: NOW,
    site: 'chatgpt',
    action: 'protected',
    categories: ['identity'],
    count: 1,
    hadCriticalOrHigh: true,
    ...overrides,
  }
}

function baseState(overrides: Partial<GrowthState> = {}): GrowthState {
  return {
    installDate: NOW - INSTALL_MIN_AGE_MS - 60_000, // installed long enough
    firstEligibleAt: null,
    lastShownAt: null,
    dismissCount: 0,
    dismissedUntil: null,
    reviewClicked: false,
    shareClicked: false,
    permanentlySuppressed: false,
    lastProblemReportAt: null,
    ...overrides,
  }
}

function inputs(overrides: Partial<EligibilityInputs> = {}): EligibilityInputs {
  return {
    now: NOW,
    state: baseState(),
    protectionEventCount: MIN_PROTECTION_EVENTS,
    selfTest: null,
    killSwitch: null,
    currentSiteUnsupported: false,
    mostRecentEvent: null,
    ...overrides,
  }
}

describe('isCountingAction', () => {
  it('counts real warning/decision actions, excludes clean + incomplete', () => {
    const counts: AlgAction[] = ['protected', 'cancelled', 'as-is', 'uploaded-anyway']
    for (const a of counts) expect(isCountingAction(a)).toBe(true)
    expect(isCountingAction('auto-cleared')).toBe(false)
    expect(isCountingAction('unable-to-inspect')).toBe(false)
  })
})

describe('countProtectionEvents', () => {
  it('counts only the counting actions', () => {
    const events = [
      ev({ action: 'protected', ts: NOW - 500_000 }),
      ev({ action: 'auto-cleared', ts: NOW - 400_000, categories: [], count: 0, hadCriticalOrHigh: false }),
      ev({ action: 'unable-to-inspect', ts: NOW - 300_000, categories: [], count: 0, hadCriticalOrHigh: false }),
      ev({ action: 'cancelled', ts: NOW - 200_000, site: 'claude' }),
    ]
    expect(countProtectionEvents(events)).toBe(2)
  })

  it('collapses two same-shape events within the dedup window (paste-then-send)', () => {
    const events = [
      ev({ ts: NOW - 60_000 }),
      ev({ ts: NOW - 60_000 + (DEDUP_WINDOW_MS - 1_000) }), // same shape, inside window
    ]
    expect(countProtectionEvents(events)).toBe(1)
  })

  it('counts a same-shape repeat that falls OUTSIDE the dedup window', () => {
    const events = [ev({ ts: NOW - 300_000 }), ev({ ts: NOW - 300_000 + DEDUP_WINDOW_MS + 1_000 })]
    expect(countProtectionEvents(events)).toBe(2)
  })

  it('counts different risk shapes even when adjacent in time', () => {
    const events = [
      ev({ ts: NOW - 10_000, site: 'chatgpt' }),
      ev({ ts: NOW - 9_000, site: 'claude' }), // different site → different shape
      ev({ ts: NOW - 8_000, count: 5 }), // different count → different shape
    ]
    expect(countProtectionEvents(events)).toBe(3)
  })

  it('collapses a burst of three identical events to one', () => {
    const events = [ev({ ts: NOW }), ev({ ts: NOW + 1_000 }), ev({ ts: NOW + 2_000 })]
    expect(countProtectionEvents(events)).toBe(1)
  })

  it('keeps the reference at the last COUNTED event, not the last skipped one', () => {
    // A(t0) counts; B(t+60s) skipped (within window of A); C(t+150s) is >window
    // from A → counts. Result: 2.
    const events = [
      ev({ ts: NOW }),
      ev({ ts: NOW + 60_000 }),
      ev({ ts: NOW + 150_000 }),
    ]
    expect(countProtectionEvents(events)).toBe(2)
  })

  it('treats sorted categories as shape-equal regardless of order', () => {
    const events = [
      ev({ ts: NOW, categories: ['identity', 'healthcare_patient_id'] }),
      ev({ ts: NOW + 1_000, categories: ['healthcare_patient_id', 'identity'] }),
    ]
    expect(countProtectionEvents(events)).toBe(1)
  })
})

describe('computeEligibility — positive gates', () => {
  it('is eligible when every gate passes', () => {
    expect(computeEligibility(inputs())).toEqual({ eligible: true, reason: 'eligible' })
  })

  it('blocks before the 3-day install age', () => {
    const state = baseState({ installDate: NOW - INSTALL_MIN_AGE_MS + 60_000 })
    expect(computeEligibility(inputs({ state })).reason).toBe('not-installed-long-enough')
  })

  it('blocks with fewer than the minimum protection events', () => {
    expect(
      computeEligibility(inputs({ protectionEventCount: MIN_PROTECTION_EVENTS - 1 })).reason,
    ).toBe('too-few-protection-events')
  })

  it('blocks with an unset install date', () => {
    expect(computeEligibility(inputs({ state: baseState({ installDate: 0 }) })).reason).toBe(
      'not-installed-long-enough',
    )
  })
})

describe('computeEligibility — completion + permanent suppression', () => {
  it('never nags again once the review was clicked', () => {
    expect(computeEligibility(inputs({ state: baseState({ reviewClicked: true }) })).reason).toBe(
      'already-completed',
    )
  })

  it('stays hidden when permanently suppressed', () => {
    expect(
      computeEligibility(inputs({ state: baseState({ permanentlySuppressed: true }) })).reason,
    ).toBe('permanently-suppressed')
  })
})

describe('computeEligibility — dismissal window', () => {
  it('is suppressed inside the 30-day dismissal window', () => {
    const state = baseState({ dismissedUntil: NOW + DISMISS_SUPPRESS_MS - 1_000 })
    expect(computeEligibility(inputs({ state })).reason).toBe('dismissed-recently')
  })

  it('re-appears once the dismissal window has elapsed', () => {
    const state = baseState({ dismissedUntil: NOW - 1_000, dismissCount: 1 })
    expect(computeEligibility(inputs({ state })).eligible).toBe(true)
  })
})

describe('computeEligibility — failure suppression (bad experience → support)', () => {
  it('suppresses on a recent self-test FAIL only', () => {
    expect(
      computeEligibility(inputs({ selfTest: { result: 'fail', tsMs: NOW - 1_000 } })).reason,
    ).toBe('suppressed-self-test-fail')
    // a pass does not suppress
    expect(
      computeEligibility(inputs({ selfTest: { result: 'confirmed', tsMs: NOW - 1_000 } })).eligible,
    ).toBe(true)
    // a stale fail (outside the window) does not suppress
    expect(
      computeEligibility(
        inputs({ selfTest: { result: 'fail', tsMs: NOW - SELF_TEST_FAIL_WINDOW_MS - 1_000 } }),
      ).eligible,
    ).toBe(true)
  })

  it('suppresses while the submit kill switch is recent', () => {
    expect(computeEligibility(inputs({ killSwitch: { ts: NOW - 1_000 } })).reason).toBe(
      'suppressed-kill-switch',
    )
    expect(
      computeEligibility(inputs({ killSwitch: { ts: NOW - KILL_SWITCH_WINDOW_MS - 1_000 } }))
        .eligible,
    ).toBe(true)
  })

  it('suppresses on an unsupported current site', () => {
    expect(computeEligibility(inputs({ currentSiteUnsupported: true })).reason).toBe(
      'suppressed-unsupported-site',
    )
  })

  it('suppresses for a window after a problem report', () => {
    const state = baseState({ lastProblemReportAt: NOW - 1_000 })
    expect(computeEligibility(inputs({ state })).reason).toBe('suppressed-problem-report')
    const stale = baseState({ lastProblemReportAt: NOW - PROBLEM_REPORT_SUPPRESS_MS - 1_000 })
    expect(computeEligibility(inputs({ state: stale })).eligible).toBe(true)
  })

  it('suppresses when the most recent event was unable-to-inspect', () => {
    expect(
      computeEligibility(inputs({ mostRecentEvent: { action: 'unable-to-inspect', ts: NOW - 1_000 } }))
        .reason,
    ).toBe('suppressed-unable-to-inspect')
    // a non-recent unable-to-inspect does not suppress
    expect(
      computeEligibility(
        inputs({ mostRecentEvent: { action: 'unable-to-inspect', ts: NOW - 5 * 24 * 60 * 60 * 1000 } }),
      ).eligible,
    ).toBe(true)
    // a recent normal event does not suppress
    expect(
      computeEligibility(inputs({ mostRecentEvent: { action: 'protected', ts: NOW - 1_000 } }))
        .eligible,
    ).toBe(true)
  })
})
