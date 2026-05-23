import { describe, it, expect, vi, afterEach } from 'vitest'
import { undoMask } from '../src/content/undo'
import { incrementCounters } from '../src/shared/counter'
import { getCounters } from '../src/shared/storage'
import type { SiteAdapter } from '../src/content/adapters/base'
import type { Finding, Severity } from '../src/detector/types'

function finding(ruleId: string, severity: Severity = 'high'): Finding {
  return { ruleId, label: ruleId, severity, start: 0, end: 1, value: 'x' }
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
  it('returns true and decrements counters when restoration succeeds', async () => {
    await incrementCounters([finding('ssn'), finding('ssn')])
    const ok = undoMask(fakeAdapter(true), textarea('[SSN]'), 'original', '[SSN]', [finding('ssn')])
    expect(ok).toBe(true)
    await flush()
    expect((await getCounters()).total).toBe(1)
  })

  it('returns false, warns, and leaves counters unchanged when restoration fails', async () => {
    await incrementCounters([finding('ssn'), finding('ssn')])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const ok = undoMask(fakeAdapter(false), textarea('[SSN]'), 'original', '[SSN]', [
      finding('ssn'),
    ])

    expect(ok).toBe(false)
    expect(warn).toHaveBeenCalledOnce()
    await flush()
    const counters = await getCounters()
    expect(counters.total).toBe(2)
    expect(counters.byType.ssn).toBe(2)
  })

  it('restores only the masked span, preserving text typed after the paste', () => {
    let restored: string | undefined
    const ok = undoMask(
      fakeAdapter(true, (text) => {
        restored = text
      }),
      textarea('[SSN] and a note'),
      '123-45-6789',
      '[SSN]',
      [finding('ssn')],
    )
    expect(ok).toBe(true)
    expect(restored).toBe('123-45-6789 and a note')
  })

  it('falls back to the original text when the masked span is no longer present', () => {
    let restored: string | undefined
    undoMask(
      fakeAdapter(true, (text) => {
        restored = text
      }),
      textarea('the user rewrote everything'),
      '123-45-6789',
      '[SSN]',
      [finding('ssn')],
    )
    expect(restored).toBe('123-45-6789')
  })
})
