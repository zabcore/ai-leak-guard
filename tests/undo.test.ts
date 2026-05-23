import { describe, it, expect, vi, afterEach } from 'vitest'
import { undoMask } from '../src/content/undo'
import { incrementCounters } from '../src/shared/counter'
import { getCounters } from '../src/shared/storage'
import type { SiteAdapter } from '../src/content/adapters/base'
import type { MaskedSegment } from '../src/content/masker'
import type { Finding, Severity } from '../src/detector/types'

function finding(ruleId: string, severity: Severity = 'high'): Finding {
  return { ruleId, label: ruleId, severity, start: 0, end: 1, value: 'x' }
}

function segment(placeholder: string, original: string, ruleId = 'ssn'): MaskedSegment {
  return { placeholder, original, ruleId, label: ruleId }
}

function fakeAdapter(replaceResult: boolean, onReplace?: (text: string) => void): SiteAdapter {
  return {
    domains: [],
    id: 'fake',
    isPromptInput: () => true,
    insertText: () => true,
    replaceContents: (_target, text) => {
      onReplace?.(text)
      return replaceResult
    },
  }
}

function textarea(value: string): Element {
  return { tagName: 'TEXTAREA', value } as unknown as Element
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

afterEach(() => {
  vi.restoreAllMocks()
})

describe('undoMask', () => {
  it('replaces only the placeholder, preserving text typed after the paste (BUG D)', () => {
    let restored: string | undefined
    const ok = undoMask(
      fakeAdapter(true, (text) => {
        restored = text
      }),
      textarea('My SSN is [US_SOCIAL_SECURITY_NUMBER] and I need help please'),
      [segment('[US_SOCIAL_SECURITY_NUMBER]', '123-45-6789')],
      [finding('ssn')],
    )
    expect(ok).toBe(true)
    expect(restored).toBe('My SSN is 123-45-6789 and I need help please')
  })

  it('restores multiple placeholders to their respective originals', () => {
    let restored: string | undefined
    undoMask(
      fakeAdapter(true, (text) => {
        restored = text
      }),
      textarea('a [SSN] b [AWS] c'),
      [segment('[SSN]', '123-45-6789', 'ssn'), segment('[AWS]', 'AKIAEXAMPLE', 'aws')],
      [finding('ssn'), finding('aws')],
    )
    expect(restored).toBe('a 123-45-6789 b AKIAEXAMPLE c')
  })

  it('maps repeated identical placeholders in order', () => {
    let restored: string | undefined
    undoMask(
      fakeAdapter(true, (text) => {
        restored = text
      }),
      textarea('[SSN] then [SSN]'),
      [segment('[SSN]', '111-11-1111'), segment('[SSN]', '222-22-2222')],
      [finding('ssn'), finding('ssn')],
    )
    expect(restored).toBe('111-11-1111 then 222-22-2222')
  })

  it('refuses to restore (no replace, returns false) when a placeholder is gone', () => {
    let replaceCalled = false
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ok = undoMask(
      fakeAdapter(true, () => {
        replaceCalled = true
      }),
      textarea('the user deleted the placeholder entirely'),
      [segment('[US_SOCIAL_SECURITY_NUMBER]', '123-45-6789')],
      [finding('ssn')],
    )
    expect(ok).toBe(false)
    expect(replaceCalled).toBe(false)
    expect(warn).toHaveBeenCalledOnce()
  })

  it('returns false and warns when replaceContents fails', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ok = undoMask(
      fakeAdapter(false),
      textarea('[SSN]'),
      [segment('[SSN]', '123-45-6789')],
      [finding('ssn')],
    )
    expect(ok).toBe(false)
    expect(warn).toHaveBeenCalledOnce()
  })

  it('decrements counters when restoration succeeds', async () => {
    await incrementCounters([finding('ssn'), finding('ssn')])
    const ok = undoMask(
      fakeAdapter(true),
      textarea('[SSN]'),
      [segment('[SSN]', '123-45-6789')],
      [finding('ssn')],
    )
    expect(ok).toBe(true)
    await flush()
    expect((await getCounters()).total).toBe(1)
  })

  it('does not decrement counters when restoration is refused', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await incrementCounters([finding('ssn'), finding('ssn')])
    undoMask(
      fakeAdapter(true),
      textarea('edited away'),
      [segment('[SSN]', '123-45-6789')],
      [finding('ssn')],
    )
    await flush()
    expect((await getCounters()).total).toBe(2)
  })
})
