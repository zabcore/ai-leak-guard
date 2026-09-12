// V1.3.1 §E — report-flow PRIVACY INVARIANTS.
//
// Reports, the pasteable block, the preview, and the URL must NEVER
// contain: draft text, PHI, detected values, clipboard content,
// filenames, full URLs, DOM, raw exception messages/stacks, or
// content-derived hashes. Every output is built from ONE normalized
// allowlist that reads named fields only and coerces each — so junk
// handed in is dropped/coerced by construction.

import { describe, expect, it } from 'vitest'
import {
  buildSelfTestReportUrl,
  buildFixedReportUrl,
  buildDiagnosticsBlock,
  reportFields,
  normalizeReportInput,
  stepForCode,
  SELF_TEST_REPORT_ALLOWED_PARAMS,
  SELF_TEST_SITES,
  ADAPTER_STATES,
  SELF_TEST_STEPS,
  type SelfTestReportInput,
} from '../src/shared/self-test-report'

// A hostile input: valid allowlist fields PLUS every forbidden thing a
// bug might try to smuggle through. Cast so TS lets the junk in.
const HOSTILE = {
  site: 'chatgpt',
  ext: '1.3.0',
  adapter: 'chatgpt',
  adapterState: 'unavailable',
  step: 'modal',
  result: 'fail',
  code: 'NO_MODAL',
  composer: 1,
  intercept: 1,
  modal: 0,
  browser: 'Chrome/128',
  ts: '2026-09-10T09:00:00.000Z',
  // forbidden extras:
  draft: 'Patient Jane Doe MRN 12345678',
  phi: 'SSN 123-45-6789',
  value: '123-45-6789',
  clipboard: 'secret clipboard contents',
  filename: 'discharge-summary.pdf',
  url: 'https://chatgpt.com/c/abc-123-secret',
  dom: '<div id="prompt">…</div>',
  note: 'free text the user never typed',
  stack: 'Error: boom\n  at foo (bar.ts:1:1)',
  message: 'TypeError: cannot read x of undefined',
  hash: 'a1b2c3d4e5f6',
  email: 'user@example.com',
} as unknown as SelfTestReportInput

const FORBIDDEN_SUBSTRINGS = [
  'Jane Doe',
  '12345678',
  '123-45-6789',
  'clipboard',
  'discharge-summary',
  'chatgpt.com/c/',
  'prompt',
  'free text',
  'boom',
  'bar.ts',
  'TypeError',
  'a1b2c3d4',
  'user@example.com',
  'draft',
  'phi',
  'note',
  'stack',
]

describe('§E report privacy — allowlist by construction', () => {
  it('the URL builder emits ONLY the allowlisted params, none of the junk', () => {
    const url = new URL(buildSelfTestReportUrl(HOSTILE))
    expect(new Set([...url.searchParams.keys()])).toEqual(new Set(SELF_TEST_REPORT_ALLOWED_PARAMS))
    const raw = url.search
    for (const needle of FORBIDDEN_SUBSTRINGS) expect(raw).not.toContain(needle)
  })

  it('the diagnostics block contains none of the junk', () => {
    const block = buildDiagnosticsBlock(HOSTILE)
    for (const needle of FORBIDDEN_SUBSTRINGS) expect(block).not.toContain(needle)
    // It DOES carry the allowlisted, content-free fields.
    expect(block).toContain('Code: NO_MODAL')
    expect(block).toContain('Source: extension_selftest')
  })

  it('the preview fields contain none of the junk', () => {
    const serialized = JSON.stringify(reportFields(HOSTILE))
    for (const needle of FORBIDDEN_SUBSTRINGS) expect(serialized).not.toContain(needle)
  })

  it('the FIXED page URL carries NO run-specific data (only attribution src)', () => {
    const url = new URL(buildFixedReportUrl())
    expect([...url.searchParams.keys()]).toEqual(['src'])
    expect(url.searchParams.get('src')).toBe('extension_selftest')
  })

  it('unknown enum values coerce to safe tokens (no arbitrary text passes)', () => {
    const n = normalizeReportInput({
      site: 'evil.example/leak',
      ext: '1.3.0',
      adapter: 'totally-made-up',
      adapterState: 'pwned',
      step: 'exfiltrate',
      result: 'sneaky',
      code: 'CUSTOM_LEAK_PAYLOAD',
      composer: 1,
      intercept: 1,
      modal: 0,
      browser: 'Chrome/128',
      ts: '2026-09-10T09:00:00.000Z',
    })
    expect(SELF_TEST_SITES.includes(n.site as never) || n.site === 'unknown').toBe(true)
    expect(n.site).toBe('unknown')
    expect(n.adapter).toBe('unknown')
    expect(ADAPTER_STATES.includes(n.adapterState as never)).toBe(true)
    expect(SELF_TEST_STEPS.includes(n.step as never)).toBe(true)
    expect(n.result).toBe('fail') // unknown result → safe 'fail'
    expect(n.code).toBe('TIMEOUT') // unknown code → safe 'TIMEOUT'
  })

  it('code is a fixed enum: a thrown error is mapped to a code, never its message/stack', () => {
    // The runner maps a thrown scan to a CODE; the report only ever sees
    // that enum. Prove an arbitrary "code" that looks like an error string
    // cannot pass — it coerces to TIMEOUT, and stepForCode stays enum.
    const n = normalizeReportInput({
      ...HOSTILE,
      code: 'Error: cannot read message of undefined at foo',
    } as unknown as SelfTestReportInput)
    expect(n.code).toBe('TIMEOUT')
    expect(SELF_TEST_STEPS.includes(stepForCode(n.code))).toBe(true)
    expect(
      buildDiagnosticsBlock({ ...HOSTILE, code: 'Error: boom' } as unknown as SelfTestReportInput),
    ).not.toContain('boom')
  })
})
