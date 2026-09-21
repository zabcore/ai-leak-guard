// @vitest-environment jsdom
//
// V1.3.4 — the popup "Show AI Leak Guard on this page" toggle. It reflects and
// flips the SAME per-origin chip flag the on-page "×" sets
// (`algIndicatorDismissed:<origin>`), keyed by the active tab's real URL origin,
// and only appears on a supported AI site.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { chipSiteForUrl, setupChipVisibilityToggle } from '../src/popup/popup'
import { indicatorDismissedKey } from '../src/shared/storage'

function mountDom(): void {
  document.body.innerHTML = `
    <label class="toggle" id="chip-visibility" hidden>
      <input type="checkbox" id="chip-toggle" checked />
      <span class="toggle__label">Show AI Leak Guard on this page</span>
    </label>
    <p class="popup__hint" hidden id="chip-visibility-hint">Open a supported AI site to show the on-page indicator.</p>`
}

function stubStorage(getResult: Record<string, unknown> = {}): {
  set: ReturnType<typeof vi.fn>
  remove: ReturnType<typeof vi.fn>
} {
  const set = vi.fn(async () => {})
  const remove = vi.fn(async () => {})
  ;(globalThis as { chrome?: unknown }).chrome = {
    storage: {
      local: {
        get: vi.fn(async () => getResult),
        set,
        remove,
      },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  }
  return { set, remove }
}

const control = () => document.getElementById('chip-visibility') as HTMLElement
const input = () => document.getElementById('chip-toggle') as HTMLInputElement
const hint = () => document.getElementById('chip-visibility-hint') as HTMLElement

afterEach(() => {
  document.body.innerHTML = ''
  delete (globalThis as { chrome?: unknown }).chrome
  vi.restoreAllMocks()
})

describe('chipSiteForUrl (origin + supported)', () => {
  it('supported hosts resolve to the REAL URL origin (not a canonical alias)', () => {
    expect(chipSiteForUrl('https://chatgpt.com/c/abc')).toEqual({
      origin: 'https://chatgpt.com',
      supported: true,
    })
    // chat.openai.com is the same adapter but a DIFFERENT origin — the key must
    // track the real host the content script keys by.
    expect(chipSiteForUrl('https://chat.openai.com/')).toEqual({
      origin: 'https://chat.openai.com',
      supported: true,
    })
    expect(chipSiteForUrl('https://claude.ai/new')).toEqual({
      origin: 'https://claude.ai',
      supported: true,
    })
    // Bare perplexity.ai and Copilot are covered surfaces too.
    expect(chipSiteForUrl('https://perplexity.ai/')).toMatchObject({ supported: true })
    expect(chipSiteForUrl('https://copilot.cloud.microsoft/')).toMatchObject({ supported: true })
  })

  it('non-covered hosts and junk are unsupported', () => {
    expect(chipSiteForUrl('https://example.com/')).toEqual({
      origin: 'https://example.com',
      supported: false,
    })
    expect(chipSiteForUrl('')).toEqual({ origin: '', supported: false })
    expect(chipSiteForUrl(undefined)).toEqual({ origin: '', supported: false })
    expect(chipSiteForUrl('not a url')).toEqual({ origin: '', supported: false })
  })
})

describe('setupChipVisibilityToggle', () => {
  it('supported + not dismissed → toggle shown and CHECKED, hint hidden', async () => {
    mountDom()
    stubStorage({}) // no flag => not dismissed
    await setupChipVisibilityToggle('https://chatgpt.com/')
    expect(control().hidden).toBe(false)
    expect(hint().hidden).toBe(true)
    expect(input().checked).toBe(true)
  })

  it('supported + dismissed → toggle shown but UNCHECKED (reflects getIndicatorDismissed)', async () => {
    mountDom()
    stubStorage({ [indicatorDismissedKey('https://claude.ai')]: true })
    await setupChipVisibilityToggle('https://claude.ai/chat')
    expect(control().hidden).toBe(false)
    expect(input().checked).toBe(false)
  })

  it('unchecking → setIndicatorDismissed(origin, true): sets the flag for the real origin', async () => {
    mountDom()
    const { set } = stubStorage({})
    await setupChipVisibilityToggle('https://chatgpt.com/')
    input().checked = false
    input().dispatchEvent(new Event('change'))
    await Promise.resolve()
    expect(set).toHaveBeenCalledWith({ [indicatorDismissedKey('https://chatgpt.com')]: true })
  })

  it('re-checking → setIndicatorDismissed(origin, false): removes the flag', async () => {
    mountDom()
    const { remove } = stubStorage({ [indicatorDismissedKey('https://chatgpt.com')]: true })
    await setupChipVisibilityToggle('https://chatgpt.com/')
    expect(input().checked).toBe(false) // started dismissed
    input().checked = true
    input().dispatchEvent(new Event('change'))
    await Promise.resolve()
    expect(remove).toHaveBeenCalledWith(indicatorDismissedKey('https://chatgpt.com'))
  })

  it('non-supported active tab → toggle hidden, hint shown, no storage read', async () => {
    mountDom()
    const { set, remove } = stubStorage({})
    await setupChipVisibilityToggle('https://example.com/')
    expect(control().hidden).toBe(true)
    expect(hint().hidden).toBe(false)
    // A disabled/hidden toggle must not write anything.
    expect(set).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
  })
})
