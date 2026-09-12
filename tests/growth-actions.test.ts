// V1.3.1 §Growth Loop — pure state-reducer transitions (fake clock).

import { describe, expect, it } from 'vitest'
import {
  applyDismiss,
  applyProblemReport,
  applyReEnable,
  applyReviewClicked,
  applyShareClicked,
  ensureInstallDate,
  freshState,
  markEligible,
  markShown,
} from '../src/growth/eligibility'
import { DISMISS_SUPPRESS_MS } from '../src/growth/constants'

const NOW = 1_800_000_000_000

describe('freshState', () => {
  it('is a metadata-only default with installDate set to now', () => {
    const s = freshState(NOW)
    expect(s.installDate).toBe(NOW)
    expect(s.dismissCount).toBe(0)
    expect(s.reviewClicked).toBe(false)
    expect(s.permanentlySuppressed).toBe(false)
  })
})

describe('ensureInstallDate', () => {
  it('sets the install date only when unset', () => {
    expect(ensureInstallDate(freshState(0), NOW).installDate).toBe(NOW)
    const existing = { ...freshState(NOW - 5000) }
    expect(ensureInstallDate(existing, NOW).installDate).toBe(NOW - 5000)
  })
})

describe('markEligible / markShown', () => {
  it('records firstEligibleAt once and lastShownAt each time', () => {
    const s1 = markEligible(freshState(NOW), NOW)
    expect(s1.firstEligibleAt).toBe(NOW)
    const s2 = markEligible(s1, NOW + 10_000)
    expect(s2.firstEligibleAt).toBe(NOW) // idempotent
    const s3 = markShown(s2, NOW + 20_000)
    expect(s3.lastShownAt).toBe(NOW + 20_000)
  })
})

describe('applyDismiss', () => {
  it('first dismissal: 30-day window, not yet permanent', () => {
    const s = applyDismiss(freshState(NOW), NOW)
    expect(s.dismissCount).toBe(1)
    expect(s.dismissedUntil).toBe(NOW + DISMISS_SUPPRESS_MS)
    expect(s.permanentlySuppressed).toBe(false)
  })

  it('second dismissal becomes permanent', () => {
    const once = applyDismiss(freshState(NOW), NOW)
    const twice = applyDismiss(once, NOW + 1_000)
    expect(twice.dismissCount).toBe(2)
    expect(twice.permanentlySuppressed).toBe(true)
  })
})

describe('applyReviewClicked / applyShareClicked', () => {
  it('records the CTA clicks', () => {
    expect(applyReviewClicked(freshState(NOW)).reviewClicked).toBe(true)
    expect(applyShareClicked(freshState(NOW)).shareClicked).toBe(true)
  })
})

describe('applyProblemReport', () => {
  it('records the problem-report timestamp', () => {
    expect(applyProblemReport(freshState(NOW), NOW).lastProblemReportAt).toBe(NOW)
  })
})

describe('applyReEnable', () => {
  it('clears permanent suppression + dismissal window and resets the count', () => {
    const suppressed = applyDismiss(applyDismiss(freshState(NOW), NOW), NOW + 1_000)
    expect(suppressed.permanentlySuppressed).toBe(true)
    const reenabled = applyReEnable(suppressed)
    expect(reenabled.permanentlySuppressed).toBe(false)
    expect(reenabled.dismissedUntil).toBeNull()
    expect(reenabled.dismissCount).toBe(0)
  })

  it('does NOT undo a completed review', () => {
    const reviewed = applyReviewClicked(freshState(NOW))
    expect(applyReEnable(reviewed).reviewClicked).toBe(true)
  })
})
