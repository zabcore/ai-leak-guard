// V1.3 M5 — the "Report this" URL builder. The privacy invariant: it
// emits ONLY the allowlisted, content-free params — never composer text,
// filenames, PHI, findings, identifiers, or the full user-agent — even
// when handed extra fields.

import { describe, expect, it } from 'vitest'
import {
  buildSelfTestReportUrl,
  coarseBrowser,
  SELF_TEST_REPORT_ENDPOINT,
  SELF_TEST_REPORT_ALLOWED_PARAMS,
  type SelfTestReportInput,
} from '../src/shared/self-test-report'

const base: SelfTestReportInput = {
  site: 'chatgpt',
  ext: '1.2.1',
  adapter: 'chatgpt',
  result: 'fail',
  code: 'NO_MODAL',
  composer: 1,
  intercept: 1,
  modal: 0,
  browser: 'Chrome/128',
  ts: '2026-09-05T18:00:00.000Z',
}

describe('buildSelfTestReportUrl', () => {
  it('targets the zabcore endpoint and sets src=extension_selftest', () => {
    const url = new URL(buildSelfTestReportUrl(base))
    expect(`${url.origin}${url.pathname}`).toBe(SELF_TEST_REPORT_ENDPOINT)
    expect(url.searchParams.get('src')).toBe('extension_selftest')
  })

  it('emits ONLY the allowlisted params', () => {
    const url = new URL(buildSelfTestReportUrl(base))
    const keys = [...url.searchParams.keys()]
    for (const k of keys) expect(SELF_TEST_REPORT_ALLOWED_PARAMS).toContain(k)
    // And every allowlisted key is present.
    expect(new Set(keys)).toEqual(new Set(SELF_TEST_REPORT_ALLOWED_PARAMS))
  })

  it('never leaks extra/content fields even if passed', () => {
    const dirty = {
      ...base,
      // Things that must NEVER reach the URL:
      composerText: 'Patient SSN 123-45-6789',
      text: 'Jane Doe real data',
      phi: 'MRN 999',
      filename: 'discharge.pdf',
      findings: ['ssn'],
      userAgent: 'Mozilla/5.0 (very long identifying UA) Chrome/128',
      email: 'a@b.com',
    } as unknown as SelfTestReportInput
    const url = new URL(buildSelfTestReportUrl(dirty))
    const raw = url.search
    for (const needle of [
      'composerText',
      'Patient',
      '123-45-6789',
      'Jane',
      'MRN',
      'discharge',
      'findings',
      'userAgent',
      'Mozilla',
      'email',
      'a%40b',
    ]) {
      expect(raw).not.toContain(needle)
    }
    // Only the allowlisted keys survived.
    expect(new Set([...url.searchParams.keys()])).toEqual(new Set(SELF_TEST_REPORT_ALLOWED_PARAMS))
  })

  it('normalizes booleans to 0/1 and passes ts/format through', () => {
    const url = new URL(buildSelfTestReportUrl({ ...base, composer: 1, intercept: 0, modal: 0 }))
    expect(url.searchParams.get('composer')).toBe('1')
    expect(url.searchParams.get('intercept')).toBe('0')
    expect(url.searchParams.get('modal')).toBe('0')
    expect(url.searchParams.get('ts')).toBe(base.ts)
    expect(url.searchParams.get('code')).toBe('NO_MODAL')
  })
})

describe('coarseBrowser', () => {
  it('reduces a full UA to Name/Major, never the full string', () => {
    const chrome =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
    expect(coarseBrowser(chrome)).toBe('Chrome/128')
    const edge = chrome.replace('Safari/537.36', 'Safari/537.36 Edg/128.0.0.0')
    expect(coarseBrowser(edge)).toBe('Edge/128')
    expect(coarseBrowser('Mozilla/5.0 Firefox/130.0')).toBe('Firefox/130')
    expect(coarseBrowser(undefined)).toBe('unknown')
    expect(coarseBrowser('some weird string')).toBe('unknown')
  })
})
