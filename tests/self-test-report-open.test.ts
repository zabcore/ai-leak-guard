// @vitest-environment jsdom
//
// V1.3 M5 (follow-up 2) / V1.3.1 §E — the in-tab "Report this" flow.
// Content scripts have no `chrome.tabs`, so it opens via `window.open`.
// §E adds a PRE-OPEN PREVIEW and a FIXED-page default (no run data in the
// URL) + a copied diagnostics block. These tests drive the flow through
// an injected preview seam (auto-proceed) and assert the fixed-page URL
// carries no run data, plus the legacy URL-override path.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { openSelfTestReport, reportUrlForRecord } from '../src/content/submit/self-test-report-open'
import { SELF_TEST_REPORT_ENDPOINT } from '../src/shared/self-test-report'
import type { ReportField } from '../src/shared/self-test-report'
import type { SelfTestResultRecord } from '../src/shared/self-test'

// A preview seam that immediately proceeds (the real UI is covered by
// self-test-report-preview.test.ts). Records what it was shown.
function autoProceedPreview() {
  const shown: { fields: readonly ReportField[]; block: string } = { fields: [], block: '' }
  const preview = (
    fields: readonly ReportField[],
    block: string,
    deps: { onProceed: () => void },
  ) => {
    shown.fields = fields
    shown.block = block
    deps.onProceed()
    return { close: () => {}, host: document.createElement('div'), shadow: {} as ShadowRoot }
  }
  return { preview, shown }
}

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

describe('openSelfTestReport — §E preview + fixed page (content-script, no chrome.tabs)', () => {
  it('default path: proceed → copies the block + opens the FIXED page with NO run data', () => {
    // A realistic content-script `chrome`: runtime/storage only, NO tabs.
    ;(globalThis as { chrome?: unknown }).chrome = {
      runtime: { getManifest: () => ({ version: '1.2.1' }) },
      storage: { local: {} },
    }
    expect((globalThis as unknown as { chrome: { tabs?: unknown } }).chrome.tabs).toBeUndefined()

    const open = vi.fn()
    const copy = vi.fn()
    const { preview, shown } = autoProceedPreview()
    openSelfTestReport(record, { open, copy, preview })

    // Opened exactly the fixed page — attribution only, NO run data.
    expect(open).toHaveBeenCalledTimes(1)
    const url = new URL(String(open.mock.calls[0][0]))
    expect(`${url.origin}${url.pathname}`).toBe(SELF_TEST_REPORT_ENDPOINT)
    expect([...url.searchParams.keys()]).toEqual(['src'])
    expect(url.searchParams.get('src')).toBe('extension_selftest')
    // No run-specific params leaked into the URL.
    for (const k of ['code', 'site', 'ts', 'result', 'browser', 'ext', 'step', 'adapterState']) {
      expect(url.searchParams.has(k)).toBe(false)
    }
    // The content-free block was copied for the user to paste.
    expect(copy).toHaveBeenCalledTimes(1)
    expect(String(copy.mock.calls[0][0])).toContain('Code: NO_MODAL')
    // The preview was shown the same block before anything opened.
    expect(shown.block).toContain('Code: NO_MODAL')
  })

  it('dismiss (never proceed) → opens nothing and copies nothing', () => {
    const open = vi.fn()
    const copy = vi.fn()
    // A preview that never calls onProceed.
    const preview = () => ({
      close: () => {},
      host: document.createElement('div'),
      shadow: {} as ShadowRoot,
    })
    openSelfTestReport(record, { open, copy, preview })
    expect(open).not.toHaveBeenCalled()
    expect(copy).not.toHaveBeenCalled()
  })

  it('owner-override url mode: proceed → opens the content-free URL-prefill (no fixed page)', () => {
    const open = vi.fn()
    const { preview } = autoProceedPreview()
    openSelfTestReport(record, { ext: '1.2.1', userAgent: 'x', open, mode: 'url', preview })
    expect(open).toHaveBeenCalledTimes(1)
    const url = new URL(String(open.mock.calls[0][0]))
    expect(url.searchParams.get('code')).toBe('NO_MODAL')
    expect(url.searchParams.get('src')).toBe('extension_selftest')
  })

  it('never throws when the open seam fails on proceed', () => {
    const open = vi.fn(() => {
      throw new Error('blocked')
    })
    const { preview } = autoProceedPreview()
    expect(() =>
      openSelfTestReport(record, { ext: '1.2.1', userAgent: 'x', open, mode: 'url', preview }),
    ).not.toThrow()
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('reportUrlForRecord builds the allowlisted URL (endpoint + src, incl §E fields)', () => {
    const url = new URL(reportUrlForRecord(record, { ext: '1.2.1', userAgent: 'UA Chrome/128.0' }))
    expect(`${url.origin}${url.pathname}`).toBe(SELF_TEST_REPORT_ENDPOINT)
    expect(url.searchParams.get('src')).toBe('extension_selftest')
    expect(url.searchParams.get('ext')).toBe('1.2.1')
    expect(url.searchParams.get('browser')).toBe('Chrome/128')
    expect(url.searchParams.get('adapterState')).toBe('unavailable') // result 'fail'
    expect(url.searchParams.get('step')).toBe('modal') // code NO_MODAL
  })
})
