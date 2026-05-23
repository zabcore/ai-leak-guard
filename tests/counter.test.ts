import { describe, it, expect, vi, afterEach } from 'vitest'
import { incrementCounters, decrementCounters, localDateKey } from '../src/shared/counter'
import { getCounters } from '../src/shared/storage'
import type { Finding, Severity } from '../src/detector/types'

function finding(ruleId: string, severity: Severity = 'high'): Finding {
  return { ruleId, label: ruleId, severity, start: 0, end: 1, value: 'x' }
}

const today = localDateKey()

afterEach(() => {
  vi.restoreAllMocks()
})

describe('localDateKey', () => {
  it('formats local date components as zero-padded YYYY-MM-DD', () => {
    expect(localDateKey(new Date(2026, 0, 5))).toBe('2026-01-05')
    expect(localDateKey(new Date(2026, 11, 31))).toBe('2026-12-31')
  })
})

describe('incrementCounters', () => {
  it('bumps total, byType, and byDay for a single finding', async () => {
    await incrementCounters([finding('ssn')])
    const counters = await getCounters()
    expect(counters.total).toBe(1)
    expect(counters.byType.ssn).toBe(1)
    expect(counters.byDay[today]).toBe(1)
  })

  it('counts each finding in a multi-finding paste', async () => {
    await incrementCounters([finding('ssn'), finding('aws_access_key'), finding('ssn')])
    const counters = await getCounters()
    expect(counters.total).toBe(3)
    expect(counters.byType.ssn).toBe(2)
    expect(counters.byType.aws_access_key).toBe(1)
    expect(counters.byDay[today]).toBe(3)
  })

  it('accumulates across multiple calls', async () => {
    await incrementCounters([finding('ssn')])
    await incrementCounters([finding('ssn')])
    expect((await getCounters()).total).toBe(2)
  })

  it('serializes concurrent writes without losing updates', async () => {
    await Promise.all(Array.from({ length: 10 }, () => incrementCounters([finding('ssn')])))
    const counters = await getCounters()
    expect(counters.total).toBe(10)
    expect(counters.byType.ssn).toBe(10)
  })

  it('is a no-op for an empty findings array', async () => {
    await incrementCounters([])
    expect(await getCounters()).toEqual({ total: 0, byType: {}, byDay: {} })
  })

  it('warns and resolves (no unhandled rejection) when the storage write fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const originalSet = chrome.storage.local.set
    chrome.storage.local.set = vi
      .fn()
      .mockRejectedValue(new Error('quota exceeded')) as typeof chrome.storage.local.set
    try {
      await expect(incrementCounters([finding('ssn')])).resolves.toBeUndefined()
      expect(warn).toHaveBeenCalled()
    } finally {
      chrome.storage.local.set = originalSet
    }
  })
})

describe('decrementCounters', () => {
  it('reverses an increment', async () => {
    await incrementCounters([finding('ssn'), finding('ssn')])
    await decrementCounters([finding('ssn')])
    const counters = await getCounters()
    expect(counters.total).toBe(1)
    expect(counters.byType.ssn).toBe(1)
    expect(counters.byDay[today]).toBe(1)
  })

  it('never lets total go negative', async () => {
    await decrementCounters([finding('ssn')])
    expect((await getCounters()).total).toBe(0)
  })

  it('clamps byType at zero', async () => {
    await incrementCounters([finding('ssn')])
    await decrementCounters([finding('ssn'), finding('ssn')])
    const counters = await getCounters()
    expect(counters.total).toBe(0)
    expect(counters.byType.ssn).toBe(0)
  })
})
