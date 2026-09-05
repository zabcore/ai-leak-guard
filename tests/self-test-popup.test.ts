// @vitest-environment jsdom
//
// V1.3 M5 — popup pieces of the self-test: site selection, honest result
// copy (A-5), and the "Report this" button showing only on failure /
// unsupported.

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  pickSelfTestSite,
  selfTestResultCopy,
  renderSelfTestOutcome,
  renderLastSelfTestResult,
  SELF_TEST_RESULT_FRESH_MS,
} from '../src/popup/popup'
import { SELF_TEST_RESULT_KEY, type SelfTestResultRecord } from '../src/shared/self-test'

afterEach(() => {
  document.body.innerHTML = ''
  delete (globalThis as { chrome?: unknown }).chrome
  vi.restoreAllMocks()
})

describe('pickSelfTestSite', () => {
  it('prefers an already-open supported tab origin', () => {
    expect(pickSelfTestSite(['https://news.example/', 'https://claude.ai/chat/abc'])).toEqual({
      id: 'claude',
      origin: 'https://claude.ai/',
    })
    expect(pickSelfTestSite(['https://gemini.google.com/app'])).toEqual({
      id: 'gemini',
      origin: 'https://gemini.google.com/',
    })
    expect(pickSelfTestSite(['https://chat.openai.com/'])).toEqual({
      id: 'chatgpt',
      origin: 'https://chatgpt.com/',
    })
  })

  it('defaults to ChatGPT when no supported tab is open', () => {
    expect(pickSelfTestSite(['https://example.com', 'about:blank'])).toEqual({
      id: 'chatgpt',
      origin: 'https://chatgpt.com/',
    })
    expect(pickSelfTestSite([])).toEqual({ id: 'chatgpt', origin: 'https://chatgpt.com/' })
  })
})

describe('selfTestResultCopy (A-5 honesty)', () => {
  it('confirmed copy validates detection + warning, NOT actual sending', () => {
    const copy = selfTestResultCopy('confirmed', 'OK')
    expect(copy.toLowerCase()).toContain('protection confirmed')
    expect(copy.toLowerCase()).toContain('not that a real message was sent')
    // Never over-promises full send-time protection.
    expect(copy.toLowerCase()).not.toContain('fully protected')
  })

  it('has a distinct line for each state', () => {
    expect(selfTestResultCopy('unsupported', 'NO_INTERCEPT').toLowerCase()).toContain(
      'isn’t active'.toLowerCase(),
    )
    expect(selfTestResultCopy('fail', 'TIMEOUT').toLowerCase()).toContain(
      'couldn’t start'.toLowerCase(),
    )
    expect(selfTestResultCopy('fail', 'NO_MODAL').toLowerCase()).toContain(
      'couldn’t complete'.toLowerCase(),
    )
  })
})

describe('renderSelfTestOutcome — Report button visibility', () => {
  function mountDom(): void {
    document.body.innerHTML = `
      <button id="selftest-btn">Test protection</button>
      <p id="selftest-result" hidden></p>
      <button id="selftest-report" hidden>Report this</button>
    `
  }
  const rec = (
    result: SelfTestResultRecord['result'],
    code: SelfTestResultRecord['code'],
  ): SelfTestResultRecord => ({
    nonce: 'n',
    result,
    code,
    site: 'chatgpt',
    adapter: 'chatgpt',
    composer: 1,
    intercept: 1,
    modal: 0,
    ts: '2026-09-05T18:00:00.000Z',
  })

  it('shows the result line and hides Report on confirmed', () => {
    mountDom()
    renderSelfTestOutcome(rec('confirmed', 'OK'))
    const result = document.getElementById('selftest-result') as HTMLElement
    const report = document.getElementById('selftest-report') as HTMLElement
    expect(result.hidden).toBe(false)
    expect(result.textContent?.toLowerCase()).toContain('protection confirmed')
    expect(report.hidden).toBe(true)
  })

  it('reveals Report on fail and on unsupported', () => {
    mountDom()
    renderSelfTestOutcome(rec('fail', 'NO_MODAL'))
    expect((document.getElementById('selftest-report') as HTMLElement).hidden).toBe(false)

    mountDom()
    renderSelfTestOutcome(rec('unsupported', 'NO_INTERCEPT'))
    expect((document.getElementById('selftest-report') as HTMLElement).hidden).toBe(false)
  })
})

describe('renderLastSelfTestResult — surface a recent result on popup open', () => {
  function mountDom(): void {
    document.body.innerHTML = `
      <button id="selftest-btn">Test protection</button>
      <p id="selftest-result" hidden></p>
      <button id="selftest-report" hidden>Report this</button>
    `
  }
  function stubStorage(record: SelfTestResultRecord | null): { remove: ReturnType<typeof vi.fn> } {
    const remove = vi.fn(async () => {})
    ;(globalThis as { chrome?: unknown }).chrome = {
      storage: {
        local: {
          get: vi.fn(async () => (record === null ? {} : { [SELF_TEST_RESULT_KEY]: record })),
          remove,
        },
      },
    }
    return { remove }
  }
  const record = (result: SelfTestResultRecord['result'], tsMs: number): SelfTestResultRecord => ({
    nonce: 'n',
    result,
    code: result === 'confirmed' ? 'OK' : 'NO_MODAL',
    site: 'chatgpt',
    adapter: 'chatgpt',
    composer: 1,
    intercept: 1,
    modal: result === 'confirmed' ? 1 : 0,
    ts: new Date(tsMs).toISOString(),
  })

  it('renders a RECENT result and clears it (consumes the one-shot)', async () => {
    mountDom()
    const now = Date.now()
    const { remove } = stubStorage(record('confirmed', now - 5000)) // 5s ago
    await renderLastSelfTestResult(now)
    const result = document.getElementById('selftest-result') as HTMLElement
    expect(result.hidden).toBe(false)
    expect(result.textContent?.toLowerCase()).toContain('protection confirmed')
    expect(remove).toHaveBeenCalled()
  })

  it('renders Report for a recent FAIL result', async () => {
    mountDom()
    const now = Date.now()
    stubStorage(record('fail', now - 1000))
    await renderLastSelfTestResult(now)
    expect((document.getElementById('selftest-report') as HTMLElement).hidden).toBe(false)
  })

  it('does NOT render a STALE result (older than the fresh window) but still clears it', async () => {
    mountDom()
    const now = Date.now()
    const { remove } = stubStorage(record('confirmed', now - SELF_TEST_RESULT_FRESH_MS - 1000))
    await renderLastSelfTestResult(now)
    const result = document.getElementById('selftest-result') as HTMLElement
    expect(result.hidden).toBe(true)
    expect(result.textContent ?? '').toBe('')
    expect(remove).toHaveBeenCalled() // consumed even though not shown
  })

  it('no result in storage → renders nothing', async () => {
    mountDom()
    stubStorage(null)
    await renderLastSelfTestResult(Date.now())
    expect((document.getElementById('selftest-result') as HTMLElement).hidden).toBe(true)
  })
})
