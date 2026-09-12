// @vitest-environment jsdom
//
// V1.3.1 §E — the pre-open diagnostics PREVIEW. Renders the exact
// content-free fields from the shared allowlist, requires an explicit
// proceed, and dismiss opens/copies nothing.

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  showReportPreview,
  __resetReportPreviewForTests,
} from '../src/content/submit/self-test-report-preview'
import { reportFields, buildDiagnosticsBlock } from '../src/shared/self-test-report'

const HOST = '[data-ai-leak-guard-report-preview]'

const input = {
  site: 'chatgpt',
  ext: '1.3.0',
  adapter: 'chatgpt',
  adapterState: 'unavailable',
  step: 'modal',
  result: 'fail',
  code: 'NO_MODAL',
  composer: 1 as const,
  intercept: 1 as const,
  modal: 0 as const,
  browser: 'Chrome/128',
  ts: '2026-09-10T09:00:00.000Z',
}

afterEach(() => {
  __resetReportPreviewForTests()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('showReportPreview', () => {
  it('renders each allowlisted field + the pasteable block, and one panel', () => {
    const fields = reportFields(input)
    const block = buildDiagnosticsBlock(input)
    const p = showReportPreview(fields, block, { onProceed: () => {} })
    expect(document.querySelectorAll(HOST).length).toBe(1)
    const text = p.shadow.textContent ?? ''
    // Every field label + value is shown.
    for (const f of fields) {
      expect(text).toContain(f.label)
      expect(text).toContain(f.value)
    }
    // The exact block is present in the selectable <pre>.
    expect(p.shadow.querySelector('pre')?.textContent).toBe(block)
    // Honest note: nothing sent by the extension.
    expect(text.toLowerCase()).toContain('nothing is sent by the extension')
  })

  it('proceed → invokes onProceed (once); dismiss/cancel → invokes onDismiss, never onProceed', () => {
    const onProceed = vi.fn()
    const onDismiss = vi.fn()
    const p = showReportPreview(reportFields(input), buildDiagnosticsBlock(input), {
      onProceed,
      onDismiss,
    })
    const button = (label: string): HTMLButtonElement =>
      Array.from(p.shadow.querySelectorAll('button')).find(
        (b) => (b.textContent ?? '').trim() === label,
      ) as HTMLButtonElement
    button('Copy & open report').click()
    expect(onProceed).toHaveBeenCalledTimes(1)
    expect(onDismiss).not.toHaveBeenCalled()
    expect(document.querySelectorAll(HOST).length).toBe(0) // closed after proceed
  })

  it('cancel → onDismiss, no proceed, panel closed', () => {
    const onProceed = vi.fn()
    const onDismiss = vi.fn()
    const p = showReportPreview(reportFields(input), buildDiagnosticsBlock(input), {
      onProceed,
      onDismiss,
    })
    const cancel = Array.from(p.shadow.querySelectorAll('button')).find(
      (b) => (b.textContent ?? '').trim() === 'Cancel',
    ) as HTMLButtonElement
    cancel.click()
    expect(onDismiss).toHaveBeenCalledTimes(1)
    expect(onProceed).not.toHaveBeenCalled()
    expect(document.querySelectorAll(HOST).length).toBe(0)
  })

  it('writes field values with textContent only (no HTML injection)', () => {
    // Even though values are coerced upstream, the preview must never
    // interpret a value as markup.
    const fields = [{ label: 'Site', value: '<img src=x onerror=alert(1)>' }]
    const p = showReportPreview(fields, 'Site: <img src=x onerror=alert(1)>', {
      onProceed: () => {},
    })
    // No <img> element was created inside the panel — it's inert text.
    expect(p.shadow.querySelector('img')).toBeNull()
    expect(p.shadow.textContent).toContain('<img src=x onerror=alert(1)>')
  })
})
