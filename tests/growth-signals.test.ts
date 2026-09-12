// V1.3.1 §Growth Loop — signal gathering: site support + input assembly.
// Uses the in-memory chrome.storage.local shim from tests/setup.ts.

import { describe, expect, it } from 'vitest'
import { gatherEligibilityInputs, isUnsupportedSiteUrl } from '../src/growth/signals'
import { defaultGrowthState } from '../src/growth/store'
import { MIN_PROTECTION_EVENTS } from '../src/growth/constants'
import type { AlgEvent } from '../src/shared/event-log'

describe('isUnsupportedSiteUrl', () => {
  it('supported AI surfaces are NOT unsupported', () => {
    expect(isUnsupportedSiteUrl('https://chatgpt.com/c/abc')).toBe(false)
    expect(isUnsupportedSiteUrl('https://claude.ai/chat/x')).toBe(false)
    expect(isUnsupportedSiteUrl('https://gemini.google.com/app')).toBe(false)
    expect(isUnsupportedSiteUrl('https://www.perplexity.ai/')).toBe(false)
    expect(isUnsupportedSiteUrl('https://copilot.cloud.microsoft/chat')).toBe(false)
  })

  it('non-AI sites, extension pages, and blanks are unsupported', () => {
    expect(isUnsupportedSiteUrl('https://example.com/')).toBe(true)
    expect(isUnsupportedSiteUrl('chrome-extension://abc/src/popup/index.html')).toBe(true)
    expect(isUnsupportedSiteUrl('about:blank')).toBe(true)
    expect(isUnsupportedSiteUrl('')).toBe(true)
    expect(isUnsupportedSiteUrl(undefined)).toBe(true)
    expect(isUnsupportedSiteUrl(null)).toBe(true)
  })
})

function evt(overrides: Partial<AlgEvent> = {}): AlgEvent {
  return {
    ts: 1000,
    site: 'chatgpt',
    eventType: 'paste',
    action: 'protected',
    categories: ['identity'],
    count: 1,
    hadCriticalOrHigh: true,
    ...overrides,
  }
}

describe('gatherEligibilityInputs', () => {
  it('derives protection count + most-recent event from the log (activity context)', async () => {
    await chrome.storage.local.set({
      events: [
        evt({ ts: 1000, site: 'chatgpt' }),
        evt({ ts: 2000, site: 'claude' }),
        evt({ ts: 3000, site: 'gemini', action: 'cancelled' }),
        evt({ ts: 4000, action: 'auto-cleared', categories: [], count: 0, hadCriticalOrHigh: false }),
      ],
    })
    const inputs = await gatherEligibilityInputs(defaultGrowthState(), { checkActiveSite: false })
    expect(inputs.protectionEventCount).toBe(MIN_PROTECTION_EVENTS) // three counted, auto-cleared excluded
    expect(inputs.mostRecentEvent).toEqual({ action: 'auto-cleared', ts: 4000 })
    // activity page is a deliberate destination — active-site check is off
    expect(inputs.currentSiteUnsupported).toBe(false)
  })

  it('reads a recent self-test fail and kill switch from storage', async () => {
    const iso = new Date(50_000).toISOString()
    await chrome.storage.local.set({
      algSelfTestResult: { nonce: 'n', result: 'fail', code: 'NO_MODAL', ts: iso },
      submitKillSwitch: { adapterId: 'chatgpt', ts: 60_000 },
    })
    const inputs = await gatherEligibilityInputs(defaultGrowthState(), { checkActiveSite: false })
    expect(inputs.selfTest).toEqual({ result: 'fail', tsMs: 50_000 })
    expect(inputs.killSwitch).toEqual({ ts: 60_000 })
  })
})
