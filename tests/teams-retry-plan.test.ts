// Teams Lite (#78) — retry backoff planning: the rule that an extra failed
// attempt must NEVER postpone an already-pending retry (Check B follow-up).

import { describe, it, expect } from 'vitest'
import { nextRetryPlan, TEAMS_RETRY_BACKOFF_MIN } from '../src/background/teams-retry-plan'

describe('retry backoff planning', () => {
  it('preserves an already-pending retry (never postpones) regardless of count', () => {
    expect(nextRetryPlan(true, 0)).toEqual({ schedule: false })
    expect(nextRetryPlan(true, 3)).toEqual({ schedule: false })
    expect(nextRetryPlan(true, 99)).toEqual({ schedule: false })
  })

  it('schedules the current backoff step when none is pending, and advances', () => {
    expect(nextRetryPlan(false, 0)).toEqual({ schedule: true, delayMin: 1, nextCount: 1 })
    expect(nextRetryPlan(false, 1)).toEqual({ schedule: true, delayMin: 2, nextCount: 2 })
    expect(nextRetryPlan(false, 2)).toEqual({ schedule: true, delayMin: 5, nextCount: 3 })
  })

  it('caps the delay at the last backoff step but keeps advancing the counter', () => {
    const last = TEAMS_RETRY_BACKOFF_MIN[TEAMS_RETRY_BACKOFF_MIN.length - 1]
    expect(nextRetryPlan(false, 99)).toEqual({ schedule: true, delayMin: last, nextCount: 100 })
  })

  it('treats a corrupt (negative / non-finite) count as the first step', () => {
    expect(nextRetryPlan(false, -5)).toEqual({ schedule: true, delayMin: 1, nextCount: 1 })
    expect(nextRetryPlan(false, Number.NaN)).toEqual({ schedule: true, delayMin: 1, nextCount: 1 })
  })
})
