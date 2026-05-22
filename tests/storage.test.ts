import { describe, it, expect } from 'vitest'
import { getCounters, setCounters, getPrefs, setPrefs } from '../src/shared/storage'

describe('storage', () => {
  it('returns default counters when nothing is stored', async () => {
    expect(await getCounters()).toEqual({ total: 0, byType: {}, byDay: {} })
  })

  it('round-trips stored counters', async () => {
    const counters = { total: 3, byType: { ssn: 2, aws_access_key: 1 }, byDay: { '2026-05-22': 3 } }
    await setCounters(counters)
    expect(await getCounters()).toEqual(counters)
  })

  it('returns default prefs when nothing is stored', async () => {
    expect(await getPrefs()).toEqual({ enabled: true, rulesUpdatedAt: 0 })
  })

  it('merges a partial prefs update, preserving other fields', async () => {
    await setPrefs({ enabled: false })
    expect(await getPrefs()).toEqual({ enabled: false, rulesUpdatedAt: 0 })
  })

  it('updates rulesUpdatedAt without clobbering enabled', async () => {
    await setPrefs({ enabled: false })
    await setPrefs({ rulesUpdatedAt: 123 })
    expect(await getPrefs()).toEqual({ enabled: false, rulesUpdatedAt: 123 })
  })
})
