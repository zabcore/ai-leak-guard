// V1.3.3 — the in-page indicator states AVAILABILITY, not a protection
// guarantee. These pin the two load-bearing rules:
//   • activeHere is coverage + live-composer + enabled — NOT hostname-derived,
//     and a prior self-test can never make it read ready.
//   • the signals stay separate (no composite "protected").

import { describe, expect, it } from 'vitest'
import {
  computeAvailability,
  coverageSurfaceId,
  selfTestSignal,
  SELF_TEST_FRESH_MS,
} from '../src/content/availability'

describe('computeAvailability — coverage-derived signals', () => {
  it('derives the separate signals from coverage, not the hostname', () => {
    const a = computeAvailability({ surfaceId: 'chatgpt', enabled: true, composerPresent: true })
    // From src/shared/coverage.ts: chatgpt supports paste/send(resume)/document.
    expect(a.paste).toBe('ready')
    expect(a.send).toBe('ready')
    expect(a.sendMode).toBe('resume')
    expect(a.fileScanning).toBe('ready')
  })

  it('reflects a surface where a channel is unsupported (Copilot document, Perplexity send)', () => {
    const copilot = computeAvailability({
      surfaceId: 'copilot-personal',
      enabled: true,
      composerPresent: true,
    })
    expect(copilot.paste).toBe('ready')
    expect(copilot.send).toBe('ready')
    expect(copilot.sendMode).toBe('no-resume-two-press')
    expect(copilot.fileScanning).toBe('unsupported') // never claim Copilot doc coverage

    const perplexity = computeAvailability({
      surfaceId: 'perplexity',
      enabled: true,
      composerPresent: true,
    })
    expect(perplexity.send).toBe('unsupported')
    expect(perplexity.fileScanning).toBe('ready')
  })

  it('an unvalidated flag surfaces as its own state, not ready or unsupported', () => {
    const m365 = computeAvailability({
      surfaceId: 'copilot-m365',
      enabled: true,
      composerPresent: true,
    })
    expect(m365.paste).toBe('unvalidated')
  })

  it('coverageSurfaceId maps the copilot adapter to the validated personal entry', () => {
    expect(coverageSurfaceId('copilot')).toBe('copilot-personal')
    expect(coverageSurfaceId('chatgpt')).toBe('chatgpt')
  })
})

describe('computeAvailability — activeHere is composer-gated, never hostname/self-test', () => {
  it('is NOT active on a matching surface when no composer resolves (no stale green)', () => {
    const a = computeAvailability({ surfaceId: 'chatgpt', enabled: true, composerPresent: false })
    expect(a.activeHere).toBe(false)
    // The per-surface capability signals still describe the surface…
    expect(a.paste).toBe('ready')
    // …but the extension is NOT "active here" without a live composer.
  })

  it('a recent CONFIRMED self-test does NOT make activeHere true when the composer is gone', () => {
    const recentPass = selfTestSignal('confirmed', 1000, 1000) // age 0, fresh
    const a = computeAvailability({
      surfaceId: 'chatgpt',
      enabled: true,
      composerPresent: false,
      lastSelfTest: recentPass,
    })
    // The load-bearing anti-stale-green assertion.
    expect(a.activeHere).toBe(false)
    // The self-test is still exposed, but as a SEPARATE historical signal.
    expect(a.lastSelfTest?.result).toBe('confirmed')
  })

  it('is active only when enabled AND a composer is present', () => {
    expect(
      computeAvailability({ surfaceId: 'chatgpt', enabled: true, composerPresent: true })
        .activeHere,
    ).toBe(true)
    expect(
      computeAvailability({ surfaceId: 'chatgpt', enabled: false, composerPresent: true })
        .activeHere,
    ).toBe(false)
  })

  it('exposes no composite "protected" field', () => {
    const a = computeAvailability({ surfaceId: 'chatgpt', enabled: true, composerPresent: true })
    expect('protected' in a).toBe(false)
  })
})

describe('selfTestSignal staleness', () => {
  it('marks a result older than the freshness window stale', () => {
    const fresh = selfTestSignal('confirmed', 0, SELF_TEST_FRESH_MS - 1)
    expect(fresh.stale).toBe(false)
    const stale = selfTestSignal('confirmed', 0, SELF_TEST_FRESH_MS + 1)
    expect(stale.stale).toBe(true)
    expect(stale.ageMs).toBe(SELF_TEST_FRESH_MS + 1)
  })
})
