// @vitest-environment jsdom
//
// V1.3.1 §Growth Loop — the review/referral card DOM + wiring.
// Injected clock/URL/clipboard seams; the chrome.storage.local shim persists.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildGrowthCard,
  mountGrowthPrompt,
  wireSupportLink,
  type GrowthCardDeps,
} from '../src/growth/card'
import { GROWTH_COPY, INSTALL_LINK_URL, STORE_REVIEW_URL } from '../src/growth/constants'
import { defaultGrowthState, readGrowthState, writeGrowthState } from '../src/growth/store'
import type { AlgEvent } from '../src/shared/event-log'

const NOW = 1_800_000_000_000
const INSTALLED_LONG_AGO = NOW - 30 * 24 * 60 * 60 * 1000

/** Flush the fire-and-forget storage read-modify-writes the handlers kick off. */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve()
}

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

/** Seed enough counted protection events + an old install to be eligible. */
async function seedEligible(): Promise<void> {
  await writeGrowthState({ ...defaultGrowthState(), installDate: INSTALLED_LONG_AGO })
  await chrome.storage.local.set({
    events: [
      evt({ ts: 100, site: 'chatgpt' }),
      evt({ ts: 200, site: 'claude' }),
      evt({ ts: 300, site: 'gemini' }),
    ],
  })
}

let container: HTMLElement
let openUrl: ReturnType<typeof vi.fn<(url: string) => void>>
let copyText: ReturnType<typeof vi.fn<(text: string) => void>>
let deps: GrowthCardDeps

beforeEach(async () => {
  document.body.innerHTML = ''
  container = document.createElement('div')
  container.hidden = true
  document.body.appendChild(container)
  openUrl = vi.fn<(url: string) => void>()
  copyText = vi.fn<(text: string) => void>()
  // activity context (checkActiveSite: false) so no chrome.tabs.query is needed.
  deps = { checkActiveSite: false, now: () => NOW, openUrl, copyText }
  await chrome.storage.local.clear()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('buildGrowthCard — exact copy, no counts', () => {
  it('renders the exact heading, sub, and button labels', () => {
    const card = buildGrowthCard(deps, false)
    expect(card.querySelector('.growth__heading')?.textContent).toBe(GROWTH_COPY.heading)
    expect(card.querySelector('.growth__sub')?.textContent).toBe(GROWTH_COPY.sub)
    const btns = [...card.querySelectorAll('.growth__btn')].map((b) => b.textContent)
    expect(btns).toEqual([GROWTH_COPY.reviewCta, GROWTH_COPY.shareCta, GROWTH_COPY.dismissCta])
  })

  it('shows NO digits anywhere (never an event count)', () => {
    const card = buildGrowthCard(deps, false)
    expect(card.textContent ?? '').not.toMatch(/[0-9]/)
  })

  it('never uses "5 stars" or a star rating ask', () => {
    const card = buildGrowthCard(deps, false)
    const text = (card.textContent ?? '').toLowerCase()
    expect(text).not.toContain('star')
    expect(text).toContain('honest')
  })

  it('hides the review CTA when it was already clicked', () => {
    const card = buildGrowthCard(deps, true)
    const review = card.querySelector<HTMLButtonElement>('.growth__btn--review')
    expect(review?.hidden).toBe(true)
    expect(card.querySelector<HTMLElement>('.growth__thanks')?.hidden).toBe(false)
  })
})

describe('review CTA', () => {
  it('opens the Store review URL, hides the CTA, and records reviewClicked', async () => {
    const card = buildGrowthCard(deps, false)
    container.appendChild(card)
    card.querySelector<HTMLButtonElement>('.growth__btn--review')!.click()
    await flush()
    expect(openUrl).toHaveBeenCalledWith(STORE_REVIEW_URL)
    expect(card.querySelector<HTMLButtonElement>('.growth__btn--review')!.hidden).toBe(true)
    expect((await readGrowthState()).reviewClicked).toBe(true)
  })
})

describe('referral CTA', () => {
  it('copies the install link, flips the label to "Link copied", then reverts', async () => {
    vi.useFakeTimers()
    const card = buildGrowthCard(deps, false)
    container.appendChild(card)
    const share = card.querySelector<HTMLButtonElement>('.growth__btn--share')!
    share.click()
    expect(copyText).toHaveBeenCalledWith(INSTALL_LINK_URL)
    expect(share.textContent).toBe(GROWTH_COPY.linkCopied)
    await flush()
    expect((await readGrowthState()).shareClicked).toBe(true)
    vi.advanceTimersByTime(2000)
    expect(share.textContent).toBe(GROWTH_COPY.shareCta)
  })
})

describe('dismissal', () => {
  it('removes the card and records a first dismissal (30-day window)', async () => {
    const card = buildGrowthCard(deps, false)
    container.appendChild(card)
    card.querySelector<HTMLButtonElement>('.growth__btn--dismiss')!.click()
    await flush()
    expect(container.querySelector('.growth')).toBeNull()
    const s = await readGrowthState()
    expect(s.dismissCount).toBe(1)
    expect(s.dismissedUntil).toBe(NOW + 30 * 24 * 60 * 60 * 1000)
    expect(s.permanentlySuppressed).toBe(false)
  })
})

describe('mountGrowthPrompt', () => {
  it('shows the card when eligible and reveals the container', async () => {
    await seedEligible()
    const shown = await mountGrowthPrompt(container, deps)
    expect(shown).toBe(true)
    expect(container.hidden).toBe(false)
    expect(container.querySelector('.growth__heading')?.textContent).toBe(GROWTH_COPY.heading)
    // last-shown recorded
    expect((await readGrowthState()).lastShownAt).toBe(NOW)
  })

  it('shows nothing when not yet eligible (too few events)', async () => {
    await writeGrowthState({ ...defaultGrowthState(), installDate: INSTALLED_LONG_AGO })
    const shown = await mountGrowthPrompt(container, deps)
    expect(shown).toBe(false)
    expect(container.querySelector('.growth')).toBeNull()
  })

  it('sets installDate on first open so the 3-day clock starts', async () => {
    await mountGrowthPrompt(container, deps)
    expect((await readGrowthState()).installDate).toBe(NOW)
  })
})

describe('wireSupportLink — manual re-enable', () => {
  it('re-enables a permanently-suppressed prompt and shows the card', async () => {
    await writeGrowthState({
      ...defaultGrowthState(),
      installDate: INSTALLED_LONG_AGO,
      dismissCount: 2,
      permanentlySuppressed: true,
    })
    const link = document.createElement('button')
    document.body.appendChild(link)
    wireSupportLink(link, container, deps)
    link.click()
    await flush()
    expect(container.querySelector('.growth__heading')?.textContent).toBe(GROWTH_COPY.heading)
    const s = await readGrowthState()
    expect(s.permanentlySuppressed).toBe(false)
    expect(s.dismissCount).toBe(0)
  })
})
