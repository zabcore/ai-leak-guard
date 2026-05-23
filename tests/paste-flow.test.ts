// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { maskInsertAndNotify } from '../src/content/paste-flow'
import { incrementCounters } from '../src/shared/counter'
import { getCounters } from '../src/shared/storage'
import type { SiteAdapter } from '../src/content/adapters/base'
import type { Finding, Severity } from '../src/detector/types'

function finding(ruleId: string, severity: Severity = 'high'): Finding {
  return { ruleId, label: ruleId, severity, start: 0, end: 1, value: 'x' }
}

function adapterWith(insertResult: boolean): SiteAdapter {
  return {
    domains: [],
    id: 'fake',
    isPromptInput: () => true,
    insertText: () => insertResult,
    replaceContents: () => true,
  }
}

const target = {} as unknown as Element

const toastOptions = {
  count: 1,
  labels: ['SSN'],
  onUndo: () => true,
  onDismiss: () => {},
}

// jsdom 29 does not define execCommand, so vi.spyOn can't wrap it. Save and
// restore manually so a stub assigned in one test doesn't leak into others.
let originalExecCommand: typeof document.execCommand | undefined

beforeEach(() => {
  originalExecCommand = document.execCommand
})

afterEach(() => {
  if (originalExecCommand === undefined) {
    delete (document as { execCommand?: typeof document.execCommand }).execCommand
  } else {
    document.execCommand = originalExecCommand
  }
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('maskInsertAndNotify', () => {
  it('counts and shows a toast when insertion succeeds', () => {
    const result = maskInsertAndNotify(adapterWith(true), target, 'masked', [finding('ssn')], {
      ...toastOptions,
    })
    expect(result.inserted).toBe(true)
    expect(result.handle).not.toBeNull()
    expect(document.body.childElementCount).toBe(1)
  })

  it('does not count or toast when both insertion paths fail', async () => {
    // adapter fails, and jsdom has no execCommand so stub it to also fail.
    document.execCommand = vi.fn(() => false)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    // Pre-seed the counter so we can prove it stays put.
    await incrementCounters([finding('ssn'), finding('ssn')])

    const result = maskInsertAndNotify(adapterWith(false), target, 'masked', [finding('ssn')], {
      ...toastOptions,
    })

    expect(result.inserted).toBe(false)
    expect(result.handle).toBeNull()
    expect(errorSpy).toHaveBeenCalledOnce()
    expect(document.body.childElementCount).toBe(0)
    // Let any (unexpected) microtask writes flush, then confirm no change.
    await Promise.resolve()
    expect((await getCounters()).total).toBe(2)
  })
})
