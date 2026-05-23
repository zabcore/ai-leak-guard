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
  it('replaces a single placeholder, preserving text typed after the paste', () => {
    let restored: string | undefined
    const outcome = undoMask(
      fakeAdapter(true, (text) => {
        restored = text
      }),
      textarea('My SSN is [US_SOCIAL_SECURITY_NUMBER] and I need help please'),
      [segment('[US_SOCIAL_SECURITY_NUMBER]', '123-45-6789')],
      [finding('ssn')],
    )
    expect(outcome).toBe('restored')
    expect(restored).toBe('My SSN is 123-45-6789 and I need help please')
  })

  it('restores ALL placeholders in a multi-finding paste (BUG D, multi-finding)', () => {
    let restored: string | undefined
    const outcome = undoMask(
      fakeAdapter(true, (text) => {
        restored = text
      }),
      textarea(
        'My SSN is [US_SOCIAL_SECURITY_NUMBER] and my AWS key is [AWS_ACCESS_KEY] and card [CREDIT_CARD]',
      ),
      [
        segment('[US_SOCIAL_SECURITY_NUMBER]', '123-45-6789', 'ssn'),
        segment('[AWS_ACCESS_KEY]', 'AKIAIOSFODNN7EXAMPLE', 'aws'),
        segment('[CREDIT_CARD]', '4532015112830366', 'cc'),
      ],
      [finding('ssn'), finding('aws'), finding('cc')],
    )
    expect(outcome).toBe('restored')
    expect(restored).toBe(
      'My SSN is 123-45-6789 and my AWS key is AKIAIOSFODNN7EXAMPLE and card 4532015112830366',
    )
  })

  it('restores adjacent placeholders whose originals are longer (offset-shift regression)', () => {
    let restored: string | undefined
    undoMask(
      fakeAdapter(true, (text) => {
        restored = text
      }),
      textarea('[CREDIT_CARD][AWS_ACCESS_KEY]'),
      [
        segment('[CREDIT_CARD]', '4532015112830366', 'cc'),
        segment('[AWS_ACCESS_KEY]', 'AKIAIOSFODNN7EXAMPLE', 'aws'),
      ],
      [finding('cc'), finding('aws')],
    )
    expect(restored).toBe('4532015112830366AKIAIOSFODNN7EXAMPLE')
  })

  it('maps repeated identical placeholders to their originals in order', () => {
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

  it('partially restores (and reports partial) when some placeholders were edited', () => {
    let restored: string | undefined
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const outcome = undoMask(
      fakeAdapter(true, (text) => {
        restored = text
      }),
      textarea('[SSN] but the second item was edited'),
      [segment('[SSN]', '123-45-6789', 'ssn'), segment('[AWS_ACCESS_KEY]', 'AKIAEXAMPLE', 'aws')],
      [finding('ssn'), finding('aws')],
    )
    expect(outcome).toBe('partial')
    expect(restored).toBe('123-45-6789 but the second item was edited')
    expect(warn).toHaveBeenCalled()
  })

  it('fails (no replace) when no placeholders are present', () => {
    let replaceCalled = false
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const outcome = undoMask(
      fakeAdapter(true, () => {
        replaceCalled = true
      }),
      textarea('the user deleted every placeholder'),
      [segment('[US_SOCIAL_SECURITY_NUMBER]', '123-45-6789')],
      [finding('ssn')],
    )
    expect(outcome).toBe('failed')
    expect(replaceCalled).toBe(false)
    expect(warn).toHaveBeenCalledOnce()
  })

  it('fails and warns when replaceContents returns false', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const outcome = undoMask(
      fakeAdapter(false),
      textarea('[SSN]'),
      [segment('[SSN]', '123-45-6789')],
      [finding('ssn')],
    )
    expect(outcome).toBe('failed')
    expect(warn).toHaveBeenCalledOnce()
  })

  it('decrements counters on a full restore', async () => {
    await incrementCounters([finding('ssn'), finding('ssn')])
    const outcome = undoMask(
      fakeAdapter(true),
      textarea('[SSN]'),
      [segment('[SSN]', '123-45-6789')],
      [finding('ssn')],
    )
    expect(outcome).toBe('restored')
    await flush()
    expect((await getCounters()).total).toBe(1)
  })

  it('does not decrement counters on a partial restore', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await incrementCounters([finding('ssn'), finding('ssn')])
    undoMask(
      fakeAdapter(true),
      textarea('[SSN] and an edited [AWS_ACCESS_KEY_GONE]'),
      [segment('[SSN]', '123-45-6789', 'ssn'), segment('[AWS_ACCESS_KEY]', 'AKIAEXAMPLE', 'aws')],
      [finding('ssn'), finding('aws')],
    )
    await flush()
    expect((await getCounters()).total).toBe(2)
  })
})
