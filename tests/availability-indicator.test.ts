// @vitest-environment jsdom
//
// V1.3.3 — the in-page indicator renders ONLY where the extension is active
// here (a composer resolves now), states availability (never "protected"),
// exposes the signals separately, and vanishes the moment the composer is gone
// — the explicit anti-stale-green case.

import { afterEach, describe, expect, it } from 'vitest'
import {
  createAvailabilityIndicator,
  AVAILABILITY_HOST_ATTR,
} from '../src/content/availability-indicator'
import { computeAvailability, selfTestSignal, type Availability } from '../src/content/availability'

const host = () => document.querySelector(`[${AVAILABILITY_HOST_ATTR}]`)

afterEach(() => {
  document.body.innerHTML = ''
})

describe('availability indicator', () => {
  it('renders a ready pill (availability, not "protected") when active, with separate signals', () => {
    const current: Availability | null = computeAvailability({
      surfaceId: 'chatgpt',
      enabled: true,
      composerPresent: true,
    })
    const ind = createAvailabilityIndicator({ getAvailability: () => current })
    ind.refresh()

    const el = host()
    expect(el).not.toBeNull()
    const shadow = (el as HTMLElement).shadowRoot!
    // Availability wording, never a protection guarantee.
    expect(shadow.textContent).toContain('active here')
    expect(shadow.textContent?.toLowerCase()).not.toContain('protected')
    // Signals are exposed SEPARATELY (distinct elements), not one status.
    for (const id of ['composer', 'paste', 'send', 'file', 'selftest']) {
      expect(shadow.querySelector(`[data-signal="${id}"]`), `signal ${id}`).not.toBeNull()
    }
    // Backstop copy — it can't confirm its own total absence.
    expect(shadow.textContent).toContain('Test protection')
    ind.destroy()
  })

  it('does NOT render ready when the composer is absent (host removed)', () => {
    const current: Availability | null = computeAvailability({
      surfaceId: 'chatgpt',
      enabled: true,
      composerPresent: false, // no live composer
    })
    const ind = createAvailabilityIndicator({ getAvailability: () => current })
    ind.refresh()
    expect(host()).toBeNull()
  })

  it('a prior CONFIRMED self-test does not keep the pill up once the composer is gone', () => {
    // Active first (composer present) → pill shows.
    let composerPresent = true
    const recentPass = selfTestSignal('confirmed', 0, 0) // fresh pass
    const getAvailability = (): Availability =>
      computeAvailability({
        surfaceId: 'chatgpt',
        enabled: true,
        composerPresent,
        lastSelfTest: recentPass,
      })
    const ind = createAvailabilityIndicator({ getAvailability })
    ind.refresh()
    expect(host()).not.toBeNull()

    // Composer disappears (e.g. navigated away from the chat). Even with the
    // recent confirmed self-test still on record, the pill must NOT persist.
    composerPresent = false
    ind.refresh()
    expect(host()).toBeNull()

    // And it comes back when a composer resolves again.
    composerPresent = true
    ind.refresh()
    expect(host()).not.toBeNull()
    ind.destroy()
  })

  it('renders nothing on an out-of-scope surface (getAvailability returns null)', () => {
    const ind = createAvailabilityIndicator({ getAvailability: () => null })
    ind.refresh()
    expect(host()).toBeNull()
  })

  it('reflects an unsupported channel in its own signal (Perplexity send)', () => {
    const ind = createAvailabilityIndicator({
      getAvailability: () =>
        computeAvailability({ surfaceId: 'perplexity', enabled: true, composerPresent: true }),
    })
    ind.refresh()
    const shadow = (host() as HTMLElement).shadowRoot!
    expect(shadow.querySelector('[data-signal="send"]')?.textContent).toContain(
      'not on this surface',
    )
    ind.destroy()
  })
})
