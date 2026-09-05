// @vitest-environment jsdom
//
// V1.3 M5 (follow-up 2) — the in-tab "Report this" must open the report
// page from a CONTENT-SCRIPT context, where `chrome.tabs` does NOT exist.
// The earlier `chrome.tabs.create(...)` silently no-op'd there; the unit
// tests missed it because they mocked `chrome.tabs`. These tests
// explicitly withhold `chrome.tabs` and assert the URL still opens.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { openSelfTestReport, reportUrlForRecord } from '../src/content/submit/self-test-report-open'
import { SELF_TEST_REPORT_ENDPOINT } from '../src/shared/self-test-report'
import type { SelfTestResultRecord } from '../src/shared/self-test'

const record: SelfTestResultRecord = {
  nonce: 'n',
  result: 'fail',
  code: 'NO_MODAL',
  site: 'chatgpt',
  adapter: 'chatgpt',
  composer: 1,
  intercept: 1,
  modal: 0,
  ts: '2026-09-05T18:00:00.000Z',
}

afterEach(() => {
  delete (globalThis as { chrome?: unknown }).chrome
  vi.restoreAllMocks()
})

describe('openSelfTestReport — content-script context (no chrome.tabs)', () => {
  it('opens the report page via window.open when chrome.tabs is unavailable', () => {
    // A realistic content-script `chrome`: runtime/storage only, NO tabs.
    ;(globalThis as { chrome?: unknown }).chrome = {
      runtime: { getManifest: () => ({ version: '1.2.1' }) },
      storage: { local: {} },
    }
    expect((globalThis as unknown as { chrome: { tabs?: unknown } }).chrome.tabs).toBeUndefined()

    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null)
    openSelfTestReport(record)

    expect(openSpy).toHaveBeenCalledTimes(1)
    const url = String(openSpy.mock.calls[0][0])
    expect(url.startsWith(`${SELF_TEST_REPORT_ENDPOINT}?`)).toBe(true)
    expect(url).toContain('src=extension_selftest')
    expect(url).toContain('code=NO_MODAL')
    // Opened in a new tab, no opener (default hardening).
    expect(openSpy.mock.calls[0][1]).toBe('_blank')
    expect(openSpy.mock.calls[0][2]).toBe('noopener')
  })

  it('uses the injected open seam and never throws on failure', () => {
    const open = vi.fn(() => {
      throw new Error('blocked')
    })
    expect(() => openSelfTestReport(record, { ext: '1.2.1', userAgent: 'x', open })).not.toThrow()
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('reportUrlForRecord builds the allowlisted URL (endpoint + src)', () => {
    const url = new URL(reportUrlForRecord(record, { ext: '1.2.1', userAgent: 'UA Chrome/128.0' }))
    expect(`${url.origin}${url.pathname}`).toBe(SELF_TEST_REPORT_ENDPOINT)
    expect(url.searchParams.get('src')).toBe('extension_selftest')
    expect(url.searchParams.get('ext')).toBe('1.2.1')
    expect(url.searchParams.get('browser')).toBe('Chrome/128')
  })
})
