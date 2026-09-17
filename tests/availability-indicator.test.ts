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
  it('renders plain-language copy when active, with separate signals', () => {
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
    const text = shadow.textContent ?? ''
    // Plain-language header + subtitle + labels + footer.
    expect(text).toContain('AI Leak Guard is on here')
    expect(text).toContain("What it's checking on this page")
    expect(text).toContain('Active on this page')
    expect(text).toContain('Before you send')
    expect(text).toContain('Attached files')
    expect(text).toContain('Last check')
    expect(text).toContain('Sites change often')
    expect(text).toContain('Test protection')
    // Never a composite "you're protected" claim.
    expect(text.toLowerCase()).not.toContain('protected')
    // Signals are exposed SEPARATELY (distinct elements), not one status.
    for (const id of ['active', 'paste', 'send', 'file', 'selftest']) {
      expect(shadow.querySelector(`[data-signal="${id}"]`), `signal ${id}`).not.toBeNull()
    }
    ind.destroy()
  })

  it('drops internal jargon — no "Gate C", "drift", "composer", or "guarantee" anywhere in the rendered popup', () => {
    const ind = createAvailabilityIndicator({
      getAvailability: () =>
        computeAvailability({ surfaceId: 'chatgpt', enabled: true, composerPresent: true }),
    })
    ind.refresh()
    // Check the WHOLE rendered shadow DOM (text + attributes), lower-cased.
    const rendered = ((host() as HTMLElement).shadowRoot!.innerHTML ?? '').toLowerCase()
    for (const banned of ['gate c', 'drift', 'composer', 'guarantee']) {
      expect(rendered, `must not render "${banned}"`).not.toContain(banned)
    }
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
    // Perplexity send is unsupported — its own signal stays honest, plainly.
    expect(shadow.querySelector('[data-signal="send"]')?.textContent).toContain('Not available')
    expect(shadow.querySelector('[data-signal="send"]')?.textContent).not.toContain('On')
    ind.destroy()
  })
})
