// @vitest-environment jsdom
//
// V1.3.3/V1.3.4 — the in-page indicator renders ONLY where the extension is
// active here (a composer resolves now), states availability (never
// "protected"), exposes the signals separately, and vanishes the moment the
// composer is gone — the explicit anti-stale-green case.
//
// V1.3.4 — it defaults to a compact CHIP (bottom-left, clear of the site's
// composer controls) and expands into the full detail panel on hover / focus /
// tap; a "×" dismisses it per origin. These tests cover both the collapsed and
// expanded DOM, and the dismissal.

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createAvailabilityIndicator,
  AVAILABILITY_HOST_ATTR,
} from '../src/content/availability-indicator'
import { computeAvailability, selfTestSignal, type Availability } from '../src/content/availability'

const host = () => document.querySelector(`[${AVAILABILITY_HOST_ATTR}]`)
const shadowOf = () => (host() as HTMLElement).shadowRoot!
const rootEl = () => shadowOf().querySelector('.alg-ind') as HTMLElement
const chipEl = () => shadowOf().querySelector('[data-chip]') as HTMLElement
const rows = () => shadowOf().querySelectorAll('[data-signal]')

/** Expand by dispatching a real hover (mouseenter on the wrapper). */
const hoverIn = () => rootEl().dispatchEvent(new MouseEvent('mouseenter'))
const hoverOut = () => rootEl().dispatchEvent(new MouseEvent('mouseleave'))

const active = (over: Partial<Parameters<typeof computeAvailability>[0]> = {}): Availability =>
  computeAvailability({ surfaceId: 'chatgpt', enabled: true, composerPresent: true, ...over })

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('availability chip (collapsed by default)', () => {
  it('renders the chip — green dot + "AI Leak Guard" — and NOT the detail panel', () => {
    const ind = createAvailabilityIndicator({ getAvailability: () => active() })
    ind.refresh()

    expect(host()).not.toBeNull()
    const shadow = shadowOf()
    // The chip is present and labelled.
    const chip = shadow.querySelector('[data-chip]')
    expect(chip).not.toBeNull()
    expect(chip?.getAttribute('role')).toBe('button')
    expect(chip?.getAttribute('aria-expanded')).toBe('false')
    expect(chip?.getAttribute('tabindex')).toBe('0')
    expect(shadow.querySelector('.alg-ind__dot')).not.toBeNull()
    expect(shadow.textContent).toContain('AI Leak Guard')
    // Collapsed: the full panel and its signal rows are ABSENT from the DOM.
    expect(shadow.querySelector('.alg-ind__panel')).toBeNull()
    expect(rows().length).toBe(0)
    expect(shadow.textContent).not.toContain("What it's checking on this page")
    ind.destroy()
  })

  it('never makes a composite "you\'re protected" claim on the chip', () => {
    const ind = createAvailabilityIndicator({ getAvailability: () => active() })
    ind.refresh()
    expect((shadowOf().textContent ?? '').toLowerCase()).not.toContain('protected')
    ind.destroy()
  })
})

describe('availability chip (expanded)', () => {
  it('expands on hover to show the full plain-language copy + separate signals, collapses on leave', () => {
    const ind = createAvailabilityIndicator({ getAvailability: () => active() })
    ind.refresh()

    hoverIn()
    const shadow = shadowOf()
    const text = shadow.textContent ?? ''
    expect(text).toContain('AI Leak Guard is on here')
    expect(text).toContain("What it's checking on this page")
    expect(text).toContain('Active on this page')
    expect(text).toContain('Before you send')
    expect(text).toContain('Attached files')
    expect(text).toContain('Last check')
    expect(text).toContain('Sites change often')
    expect(text).toContain('Test protection')
    expect(text.toLowerCase()).not.toContain('protected')
    // Signals exposed SEPARATELY (distinct elements), not one status.
    for (const id of ['active', 'paste', 'send', 'file', 'selftest']) {
      expect(shadow.querySelector(`[data-signal="${id}"]`), `signal ${id}`).not.toBeNull()
    }
    expect(chipEl().getAttribute('aria-expanded')).toBe('true')

    // Collapse on leave: rows gone again.
    hoverOut()
    expect(rows().length).toBe(0)
    expect(chipEl().getAttribute('aria-expanded')).toBe('false')
    ind.destroy()
  })

  it('expands on keyboard focus and collapses on blur', async () => {
    const ind = createAvailabilityIndicator({ getAvailability: () => active() })
    ind.refresh()
    rootEl().dispatchEvent(new FocusEvent('focusin'))
    expect(rows().length).toBe(5)
    // Blur (focus left the shadow) collapses after the focus-guard microtask.
    rootEl().dispatchEvent(new FocusEvent('focusout'))
    await new Promise((r) => setTimeout(r, 0))
    expect(rows().length).toBe(0)
    expect(chipEl().getAttribute('aria-expanded')).toBe('false')
    ind.destroy()
  })

  it('drops internal jargon — no "Gate C", "drift", "composer", or "guarantee" in the expanded panel', () => {
    const ind = createAvailabilityIndicator({ getAvailability: () => active() })
    ind.refresh()
    hoverIn()
    const rendered = (shadowOf().innerHTML ?? '').toLowerCase()
    for (const banned of ['gate c', 'drift', 'composer', 'guarantee']) {
      expect(rendered, `must not render "${banned}"`).not.toContain(banned)
    }
    ind.destroy()
  })

  it('reflects an unsupported channel in its own signal (Perplexity send)', () => {
    const ind = createAvailabilityIndicator({
      getAvailability: () =>
        computeAvailability({ surfaceId: 'perplexity', enabled: true, composerPresent: true }),
    })
    ind.refresh()
    hoverIn()
    const shadow = shadowOf()
    expect(shadow.querySelector('[data-signal="send"]')?.textContent).toContain('Not available')
    expect(shadow.querySelector('[data-signal="send"]')?.textContent).not.toContain('On')
    ind.destroy()
  })
})

describe('anti-stale-green (unchanged)', () => {
  it('does NOT render when the composer is absent (host removed)', () => {
    const ind = createAvailabilityIndicator({
      getAvailability: () => active({ composerPresent: false }),
    })
    ind.refresh()
    expect(host()).toBeNull()
  })

  it('a prior CONFIRMED self-test does not keep the chip up once the composer is gone', () => {
    let composerPresent = true
    const recentPass = selfTestSignal('confirmed', 0, 0)
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

    composerPresent = false
    ind.refresh()
    expect(host()).toBeNull()

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

  it('an open panel stays open across a refresh (does not collapse or lose the rows)', () => {
    const ind = createAvailabilityIndicator({ getAvailability: () => active() })
    ind.refresh()
    hoverIn()
    expect(rows().length).toBe(5)
    // A periodic refresh must not rebuild the chip / collapse the panel.
    ind.refresh()
    expect(rows().length).toBe(5)
    expect(chipEl().getAttribute('aria-expanded')).toBe('true')
    ind.destroy()
  })
})

describe('dismissal (per-origin "×")', () => {
  it('clicking "×" fires onDismiss and removes the host', () => {
    const onDismiss = vi.fn()
    const ind = createAvailabilityIndicator({ getAvailability: () => active(), onDismiss })
    ind.refresh()
    expect(host()).not.toBeNull()

    const x = shadowOf().querySelector('[data-dismiss]') as HTMLElement
    expect(x).not.toBeNull()
    x.click()

    expect(onDismiss).toHaveBeenCalledTimes(1)
    expect(host()).toBeNull()
    // And it stays gone on subsequent refreshes, even while active.
    ind.refresh()
    expect(host()).toBeNull()
    ind.destroy()
  })

  it('with the origin already dismissed, refresh never renders — even when active', () => {
    const ind = createAvailabilityIndicator({
      getAvailability: () => active(),
      isDismissed: () => true,
    })
    ind.refresh()
    expect(host()).toBeNull()
  })

  it('a throwing isDismissed is treated as not-dismissed (best-effort)', () => {
    const ind = createAvailabilityIndicator({
      getAvailability: () => active(),
      isDismissed: () => {
        throw new Error('storage hiccup')
      },
    })
    expect(() => ind.refresh()).not.toThrow()
    expect(host()).not.toBeNull()
    ind.destroy()
  })

  it('the "×" does not toggle the panel open (click is a dismiss, not an expand)', () => {
    const ind = createAvailabilityIndicator({ getAvailability: () => active() })
    ind.refresh()
    const x = shadowOf().querySelector('[data-dismiss]') as HTMLElement
    x.click()
    // Host removed; nothing expanded into view.
    expect(host()).toBeNull()
  })
})
