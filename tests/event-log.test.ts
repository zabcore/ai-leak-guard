// V1.2 A5 (#40) event-log module tests.
//
// Pins the moat rule (metadata only, never content) + the ring
// buffer semantics + the best-effort posture:
//
//   • Ring buffer trims oldest past MAX_EVENTS.
//   • getEvents defensively drops malformed records.
//   • summariseEvents folds a fabricated event set into the exact
//     counts the popup renders.
//   • **No-content guard**: a stubbed `chrome.storage.local.set`
//     asserts every persisted entry has NO `value` / `text` /
//     `name` / `filename` key. The Vite build could emit any
//     shape at runtime; this test proves the shape we DO write
//     matches the schema.
//   • Best-effort: a throwing `storage.set` must NOT reject the
//     `appendEvent` promise into a caller.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DetectorCategory } from '../src/detector/types'
import {
  MAX_EVENTS,
  appendEvent,
  getEvents,
  summariseEvents,
  __resetEventLogWriteChainForTests,
  type AlgEvent,
} from '../src/shared/event-log'

function makeEvent(overrides: Partial<AlgEvent> = {}): AlgEvent {
  return {
    ts: 1_700_000_000_000,
    site: 'chatgpt',
    eventType: 'paste',
    action: 'protected',
    categories: [DetectorCategory.GOVERNMENT_FINANCIAL],
    count: 1,
    hadCriticalOrHigh: true,
    ...overrides,
  }
}

beforeEach(() => {
  __resetEventLogWriteChainForTests()
})

describe('event-log — ring buffer', () => {
  it('appends events in oldest-first order', async () => {
    await appendEvent(makeEvent({ ts: 1 }))
    await appendEvent(makeEvent({ ts: 2 }))
    await appendEvent(makeEvent({ ts: 3 }))
    const events = await getEvents()
    expect(events.map((e) => e.ts)).toEqual([1, 2, 3])
  })

  it('trims oldest past MAX_EVENTS', async () => {
    // Fewer than MAX_EVENTS: no trim.
    for (let i = 0; i < 5; i++) await appendEvent(makeEvent({ ts: i }))
    let events = await getEvents()
    expect(events).toHaveLength(5)

    // Push past MAX_EVENTS — oldest must fall off the front.
    for (let i = 5; i < MAX_EVENTS + 20; i++) await appendEvent(makeEvent({ ts: i }))
    events = await getEvents()
    expect(events).toHaveLength(MAX_EVENTS)
    // Newest MAX_EVENTS survive.
    expect(events[0].ts).toBe(MAX_EVENTS + 20 - MAX_EVENTS)
    expect(events[events.length - 1].ts).toBe(MAX_EVENTS + 19)
  })
})

describe('event-log — moat rule (metadata only, never content)', () => {
  it('storage.set never receives a value/text/name/filename key on any persisted record', async () => {
    // Spy on the real storage stub (installed by tests/setup.ts).
    const setSpy = vi.spyOn(chrome.storage.local, 'set')

    await appendEvent(makeEvent({ action: 'protected', count: 3 }))
    await appendEvent(makeEvent({ action: 'as-is', count: 1 }))
    await appendEvent(makeEvent({ action: 'cancelled', count: 2 }))
    await appendEvent(
      makeEvent({
        eventType: 'document',
        action: 'uploaded-anyway',
        categories: [DetectorCategory.HEALTHCARE_PATIENT_ID],
      }),
    )
    await appendEvent(makeEvent({ eventType: 'document', action: 'auto-cleared', count: 0 }))
    await appendEvent(
      makeEvent({
        eventType: 'document',
        action: 'unable-to-inspect',
        count: 0,
        categories: [],
      }),
    )

    // Every persisted event MUST NOT carry any content-shaped key.
    // Enumerated exhaustively so a future accidental leak (e.g., a
    // caller passing `event.value = matchedString` by mistake)
    // fails loudly at build time.
    const forbidden = ['value', 'text', 'content', 'name', 'filename', 'body', 'raw']
    for (const call of setSpy.mock.calls) {
      const payload = call[0] as Record<string, unknown>
      const events = payload.events as readonly AlgEvent[] | undefined
      if (!Array.isArray(events)) continue
      for (const evt of events) {
        for (const key of forbidden) {
          expect(evt, `event should not carry '${key}'`).not.toHaveProperty(key)
        }
      }
    }
    setSpy.mockRestore()
  })
})

describe('event-log — best-effort', () => {
  const origSet = chrome.storage.local.set
  afterEach(() => {
    chrome.storage.local.set = origSet
  })

  it('a throwing storage.set does not reject appendEvent (best-effort)', async () => {
    chrome.storage.local.set = (async () => {
      throw new Error('quota exceeded')
    }) as typeof chrome.storage.local.set
    // If this line rejects, the paste/upload flow could break —
    // the whole point of best-effort is that it does NOT.
    await expect(appendEvent(makeEvent())).resolves.toBeUndefined()
  })
})

describe('summariseEvents', () => {
  it('folds a mixed event set into the popup counters', () => {
    const events: AlgEvent[] = [
      makeEvent({ action: 'protected', site: 'chatgpt' }),
      makeEvent({ action: 'protected', site: 'claude' }),
      makeEvent({ action: 'as-is', site: 'chatgpt' }),
      makeEvent({ action: 'cancelled', site: 'gemini' }),
      makeEvent({ eventType: 'document', action: 'uploaded-anyway', site: 'chatgpt' }),
      makeEvent({ eventType: 'document', action: 'auto-cleared', site: 'chatgpt', count: 0 }),
      makeEvent({
        eventType: 'document',
        action: 'unable-to-inspect',
        site: 'perplexity',
        count: 0,
        categories: [],
      }),
    ]
    const s = summariseEvents(events)
    expect(s.total).toBe(7)
    // Detected = everything the extension reacted to (not `auto-cleared`).
    expect(s.detected).toBe(6)
    expect(s.protectedCount).toBe(2)
    expect(s.asIs).toBe(1)
    expect(s.cancelled).toBe(1)
    expect(s.uploadedAnyway).toBe(1)
    expect(s.autoCleared).toBe(1)
    expect(s.unableToInspect).toBe(1)
    expect(s.perSite).toEqual({
      chatgpt: 4,
      claude: 1,
      gemini: 1,
      perplexity: 1,
    })
  })
})

describe('event-log — projection drops hostile extra fields', () => {
  it('an event carrying `value`/`text`/`filename` lands in storage without those fields', async () => {
    // Feed a "well-shaped" AlgEvent that ALSO carries content-shaped
    // extras. `appendEvent` should project it through the allowlist
    // and persist only the seven allowed fields; the service worker
    // then projects AGAIN on receive as belt-and-braces.
    const hostile = {
      ...makeEvent({ ts: 999 }),
      value: '123-45-6789',
      text: 'Patient MRN 42',
      filename: 'ssn-list.xlsx',
      body: 'unrelated',
      __proto__: { evil: true },
    } as unknown as AlgEvent
    await appendEvent(hostile)

    // Read the raw storage payload directly — the setup shim runs
    // the shim's `shimAppendOne` inline, which mirrors the real
    // service worker's projection.
    const raw = (await chrome.storage.local.get('events')).events as unknown[]
    expect(Array.isArray(raw)).toBe(true)
    const persisted = raw[raw.length - 1] as Record<string, unknown>
    const allowedKeys = [
      'ts',
      'site',
      'eventType',
      'action',
      'categories',
      'count',
      'hadCriticalOrHigh',
    ].sort()
    // The persisted record's OWN keys must be exactly the allowlist.
    expect(Object.keys(persisted).sort()).toEqual(allowedKeys)
    // Belt-and-braces on the specific hostile fields.
    for (const key of ['value', 'text', 'filename', 'body', 'evil']) {
      expect(persisted).not.toHaveProperty(key)
    }
  })

  it('rejects an event with an invalid action (allowlist enforcement)', async () => {
    // A caller that fabricates a novel action string must NOT get
    // that novel string into storage.
    const invalid = { ...makeEvent(), action: 'exfil-patient-data' } as unknown as AlgEvent
    await appendEvent(invalid)
    const raw = (await chrome.storage.local.get('events')).events as unknown[]
    // Either not written at all, or projected off — in both cases
    // no persisted entry carries the bad action.
    for (const entry of raw ?? []) {
      const r = entry as { action?: string }
      expect(r.action).not.toBe('exfil-patient-data')
    }
  })

  it('rejects an event with an invalid category (allowlist enforcement)', async () => {
    const invalid = {
      ...makeEvent(),
      categories: ['patient_full_name_in_the_clear'],
    } as unknown as AlgEvent
    await appendEvent(invalid)
    const raw = (await chrome.storage.local.get('events')).events as unknown[]
    for (const entry of raw ?? []) {
      const r = entry as { categories?: string[] }
      expect(r.categories ?? []).not.toContain('patient_full_name_in_the_clear')
    }
  })
})

describe('getEvents — defensive read', () => {
  it('returns [] when the stored value is not an array', async () => {
    await chrome.storage.local.set({ events: 'not-an-array' })
    const events = await getEvents()
    expect(events).toEqual([])
  })

  it('filters malformed records but preserves valid ones', async () => {
    const good = makeEvent({ ts: 42 })
    await chrome.storage.local.set({
      events: [
        good,
        { ts: 'not-a-number', site: 'x' },
        null,
        { unrelated: true },
        makeEvent({ ts: 43, site: 'claude' }),
      ],
    })
    const events = await getEvents()
    expect(events).toHaveLength(2)
    expect(events.map((e) => e.ts).sort((a, b) => a - b)).toEqual([42, 43])
  })
})
