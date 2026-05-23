import { describe, it, expect, vi, afterEach } from 'vitest'
import { undoMask } from '../src/content/undo'
import { incrementCounters } from '../src/shared/counter'
import { getCounters } from '../src/shared/storage'
import type { SiteAdapter } from '../src/content/adapters/base'
import type { Finding, Severity } from '../src/detector/types'

function finding(ruleId: string, severity: Severity = 'high'): Finding {
  return { ruleId, label: ruleId, severity, start: 0, end: 1, value: 'x' }
}

function fakeAdapter(replaceResult: boolean): SiteAdapter {
  return {
    domains: [],
    id: 'fake',
    isPromptInput: () => true,
    insertText: () => true,
    replaceContents: () => replaceResult,
  }
}

const target = {} as unknown as Element

afterEach(() => {
  vi.restoreAllMocks()
})

describe('undoMask', () => {
  it('decrements counters when restoration succeeds', async () => {
    await incrementCounters([finding('ssn'), finding('ssn')])
    await undoMask(fakeAdapter(true), target, 'original', [finding('ssn')])
    expect((await getCounters()).total).toBe(1)
  })

  it('leaves counters unchanged and warns when restoration fails', async () => {
    await incrementCounters([finding('ssn'), finding('ssn')])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await undoMask(fakeAdapter(false), target, 'original', [finding('ssn')])

    const counters = await getCounters()
    expect(counters.total).toBe(2)
    expect(counters.byType.ssn).toBe(2)
    expect(warn).toHaveBeenCalledOnce()
  })
})
