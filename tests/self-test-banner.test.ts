// @vitest-environment jsdom
//
// V1.3 M5 (follow-up) — the in-tab result banner. Each terminal state
// renders the matching copy; "Report this" shows only on a genuine
// protection failure (fail/unsupported, NOT draft-present); the banner
// is DOM-only (no network, no submit/resume) and its only outbound
// action is the injected onReport callback.

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  showSelfTestBanner,
  selfTestBannerCopy,
  __resetSelfTestBannerForTests,
  type SelfTestBanner,
} from '../src/content/submit/self-test-banner'
import type { SelfTestCode, SelfTestResultKind } from '../src/shared/self-test'

const HOST = '[data-ai-leak-guard-selftest-banner]'

afterEach(() => {
  __resetSelfTestBannerForTests()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

const model = (
  result: SelfTestResultKind,
  code: SelfTestCode,
): { result: SelfTestResultKind; code: SelfTestCode } => ({ result, code })

function btn(b: SelfTestBanner, label: string): HTMLButtonElement | null {
  for (const el of Array.from(b.shadow.querySelectorAll('button'))) {
    if ((el.textContent ?? '').trim() === label) return el as HTMLButtonElement
  }
  return null
}

describe('selfTestBannerCopy', () => {
  it('confirmed keeps the A-5 honesty tail', () => {
    const copy = selfTestBannerCopy(model('confirmed', 'OK'))
    expect(copy).toContain('protection confirmed')
    expect(copy).toContain('not that a real message was sent')
  })
  it('draft-present is actionable guidance, not a failure', () => {
    const copy = selfTestBannerCopy(model('fail', 'DRAFT_PRESENT'))
    expect(copy.toLowerCase()).toContain('already text in the message box')
    expect(copy.toLowerCase()).toContain('test protection again')
  })
  it('generic failure copy for unsupported / no-modal', () => {
    expect(selfTestBannerCopy(model('unsupported', 'NO_INTERCEPT'))).toContain(
      "couldn't confirm protection",
    )
    expect(selfTestBannerCopy(model('fail', 'NO_MODAL'))).toContain("couldn't confirm protection")
  })
})

describe('showSelfTestBanner', () => {
  it('confirmed: one banner, matching copy, NO report button', () => {
    const b = showSelfTestBanner(model('confirmed', 'OK'), { autoDismissMs: 0 })
    expect(document.querySelectorAll(HOST).length).toBe(1)
    expect(b.shadow.textContent).toContain('protection confirmed')
    expect(b.hasReport).toBe(false)
    expect(btn(b, 'Report this')).toBeNull()
  })

  it('fail / unsupported: Report affordance present; click invokes onReport (only outbound action)', () => {
    const onReport = vi.fn()
    const b = showSelfTestBanner(model('fail', 'NO_MODAL'), { onReport, autoDismissMs: 0 })
    expect(b.hasReport).toBe(true)
    const report = btn(b, 'Report this')
    expect(report).not.toBeNull()
    report?.click()
    expect(onReport).toHaveBeenCalledTimes(1)
  })

  it('unsupported also shows Report', () => {
    const b = showSelfTestBanner(model('unsupported', 'NO_INTERCEPT'), { autoDismissMs: 0 })
    expect(b.hasReport).toBe(true)
  })

  it('draft-present: guidance banner, NO report button', () => {
    const b = showSelfTestBanner(model('fail', 'DRAFT_PRESENT'), { autoDismissMs: 0 })
    expect(b.hasReport).toBe(false)
    expect(b.shadow.textContent?.toLowerCase()).toContain('already text in the message box')
    expect(btn(b, 'Report this')).toBeNull()
    expect(btn(b, 'Close')).not.toBeNull()
  })

  it('Close removes the banner; only one banner exists at a time', () => {
    showSelfTestBanner(model('confirmed', 'OK'), { autoDismissMs: 0 })
    const b2 = showSelfTestBanner(model('fail', 'NO_MODAL'), { autoDismissMs: 0 })
    expect(document.querySelectorAll(HOST).length).toBe(1) // second replaced first
    btn(b2, 'Close')?.click()
    expect(document.querySelectorAll(HOST).length).toBe(0)
  })

  it('makes no network request', () => {
    const fetchSpy = vi.fn()
    ;(globalThis as unknown as { fetch: unknown }).fetch = fetchSpy
    showSelfTestBanner(model('fail', 'NO_MODAL'), { onReport: () => {}, autoDismissMs: 0 })
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
