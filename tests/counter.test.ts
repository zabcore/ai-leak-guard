import { describe, it, expect } from 'vitest'
import { incrementCounters, decrementCounters } from '../src/shared/counter'
import { getCounters } from '../src/shared/storage'
import type { Finding, Severity } from '../src/detector/types'

function finding(ruleId: string, severity: Severity = 'high'): Finding {
  return { ruleId, label: ruleId, severity, start: 0, end: 1, value: 'x' }
}

const today = new Date().toISOString().slice(0, 10)

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

  it('is a no-op for an empty findings array', async () => {
    await incrementCounters([])
    expect(await getCounters()).toEqual({ total: 0, byType: {}, byDay: {} })
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
