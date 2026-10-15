// Track D close-out (1.3.8) — the sequence-numbered trace: monotonic seq,
// persistence, ring rollover with an explicit `dropped` marker, and integrity
// states that keep "nothing recorded" distinct from "records lost".

import { describe, expect, it } from 'vitest'
import {
  MAX_TRACE_EVENTS,
  TEAMS_TRACE_KEY,
  attemptRef,
  readTraceStore,
  traceEvent,
  traceIntegrity,
  type TraceStore,
} from '../src/shared/teams-trace'

describe('traceEvent', () => {
  it('first write creates the store with trace-init at seq 1, then the event at seq 2', async () => {
    expect(await traceEvent('provision-start', { trigger: 'install' })).toBe(2)
    const store = await readTraceStore()
    expect(store?.events.map((e) => [e.seq, e.type])).toEqual([
      [1, 'trace-init'],
      [2, 'provision-start'],
    ])
    expect(store?.nextSeq).toBe(3)
    expect(store?.dropped).toBe(0)
    expect(store?.epoch).toMatch(/^[0-9a-f]{12}$/)
  })

  it('seq is monotonic across writes and concurrent writers never collide', async () => {
    await Promise.all(Array.from({ length: 25 }, (_, i) => traceEvent('e', { i })))
    const seqs = (await readTraceStore())?.events.map((e) => e.seq) ?? []
    expect(seqs).toEqual(Array.from({ length: 26 }, (_, i) => i + 1))
  })

  it('records the instant passed in (e.g. a response receipt), in ms and high resolution', async () => {
    const instant = Date.UTC(2026, 9, 15, 12, 0, 0, 123) + 0.456
    await traceEvent('revoke-response-received', {}, instant)
    const e = (await readTraceStore())?.events.at(-1)
    expect(e?.atHr).toBe(instant)
    expect(e?.at).toBe('2026-10-15T12:00:00.123Z')
  })

  it('is content-free: only primitives, capped strings, reserved fields not overridable', async () => {
    await traceEvent('x', {
      seq: 999,
      type: 'forged',
      nested: { secret: 'S' },
      list: ['S'],
      long: 'a'.repeat(500),
      n: Number.NaN,
      ok: true,
    })
    const e = (await readTraceStore())?.events.at(-1) as Record<string, unknown>
    expect(e.seq).toBe(2)
    expect(e.type).toBe('x')
    expect(e).not.toHaveProperty('nested')
    expect(e).not.toHaveProperty('list')
    expect(e).not.toHaveProperty('n')
    expect((e.long as string).length).toBe(80)
    expect(e.ok).toBe(true)
  })
})

describe('rollover and integrity', () => {
  it('past the ring size the OLDEST events are evicted and counted; seq keeps rising', async () => {
    for (let i = 0; i < MAX_TRACE_EVENTS + 5; i++) await traceEvent('e', { i })
    const store = (await readTraceStore()) as TraceStore
    // trace-init + MAX+5 events written = MAX+6; MAX retained, 6 dropped.
    expect(store.nextSeq).toBe(MAX_TRACE_EVENTS + 7)
    expect(store.dropped).toBe(6)
    expect(store.events).toHaveLength(MAX_TRACE_EVENTS)
    expect(store.events[0]?.seq).toBe(7)
    const integrity = traceIntegrity(store)
    expect(integrity).toMatchObject({
      state: 'rolled-over',
      written: MAX_TRACE_EVENTS + 6,
      retained: MAX_TRACE_EVENTS,
      dropped: 6,
      firstSeq: 7,
      lastSeq: MAX_TRACE_EVENTS + 6,
    })
    expect(integrity.meaning).toContain('seq 1..6')
  })

  it('intact: every event since init is present', async () => {
    await traceEvent('a')
    await traceEvent('b')
    expect(traceIntegrity(await readTraceStore())).toMatchObject({
      state: 'intact',
      written: 3,
      retained: 3,
      dropped: 0,
      firstSeq: 1,
      lastSeq: 3,
    })
  })

  it('absent (never traced / storage cleared) is distinct from an intact or rolled-over store', async () => {
    expect(traceIntegrity(await readTraceStore())).toMatchObject({ state: 'absent', written: 0 })
  })

  it('a gap or count mismatch is reported as inconsistent — never as complete', async () => {
    await traceEvent('a')
    await traceEvent('b')
    const store = (await readTraceStore()) as TraceStore
    const gapped = { ...store, events: store.events.filter((e) => e.seq !== 2) }
    expect(traceIntegrity(gapped).state).toBe('inconsistent')
    const truncated = { ...store, events: store.events.slice(0, 2) } // last event missing
    expect(traceIntegrity(truncated).state).toBe('inconsistent')
    const emptied = { ...store, events: [] } // "empty" while 3 were written
    expect(traceIntegrity(emptied).state).toBe('inconsistent')
  })

  it('a recreated store gets a new epoch (wiped-and-restarted is visible)', async () => {
    await traceEvent('a')
    const first = (await readTraceStore())?.epoch
    await chrome.storage.local.remove(TEAMS_TRACE_KEY)
    await traceEvent('a')
    expect((await readTraceStore())?.epoch).not.toBe(first)
  })
})

describe('attemptRef', () => {
  it('is a stable, short, one-way reference that does not contain the secret', async () => {
    const ref = await attemptRef('attempt-SECRET')
    expect(ref).toMatch(/^[0-9a-f]{12}$/)
    expect(await attemptRef('attempt-SECRET')).toBe(ref)
    expect(await attemptRef('attempt-OTHER')).not.toBe(ref)
  })
})
