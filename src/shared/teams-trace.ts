// Teams Lite (Track D close-out, 1.3.8) — the sequence-numbered event trace.
//
// An append-only, content-free log of the enrollment lifecycle, kept so that an
// export can PROVE what happened — including an attempt that started but never
// completed:
//
//   • `provision-start` is written (and awaited) BEFORE the /provision request,
//     so a request that hangs, is blocked, or dies with the worker still leaves
//     a record;
//   • `revoke-response-received` carries the instant the revoke response arrived
//     (captured at receipt), and `cleanup-completed` is a SEPARATE event written
//     after the local cleanup finished — two events, two timestamps;
//   • every event gets a monotonic `seq`. `nextSeq` never goes back, the ring
//     drops its oldest events past `MAX_TRACE_EVENTS` and counts them in
//     `dropped`, and `epoch` changes if the store is ever recreated (e.g. the
//     extension's storage was cleared). So "no events", "events lost to
//     rollover", and "store wiped" are distinguishable — see `traceIntegrity`.
//
// Content-free by construction: callers pass only enums, booleans, revision
// numbers, timestamps and identifiers (install / org id). Never a credential,
// deployment token, attempt secret, prompt text or URL. Strings are capped.
//
// Writes from the service worker and the popup are serialized with a Web Lock
// (same extension origin), falling back to an in-context chain where the Locks
// API is unavailable (tests).

export const TEAMS_TRACE_KEY = 'teamsTrace'
export const MAX_TRACE_EVENTS = 200
const LOCK_NAME = 'alg-teams-trace'
const MAX_STRING = 80

export type TraceFieldValue = string | number | boolean | null

export interface TraceEvent {
  /** Monotonic sequence number, 1-based, never reused within an epoch. */
  readonly seq: number
  readonly type: string
  /** ISO time (ms) the event's instant occurred. */
  readonly at: string
  /** The same instant in high-resolution epoch milliseconds (sub-ms). */
  readonly atHr: number
  readonly [field: string]: TraceFieldValue
}

export interface TraceStore {
  readonly v: 1
  /** Random, non-secret id of this store instance; changes if it is recreated. */
  readonly epoch: string
  readonly initAt: string
  /** The seq the NEXT event will get. Total events ever written = nextSeq - 1. */
  readonly nextSeq: number
  /** Events evicted by the ring (always the oldest: seqs 1..dropped). */
  readonly dropped: number
  readonly events: readonly TraceEvent[]
}

/** High-resolution "now" in epoch milliseconds (falls back to Date.now()). */
export function nowHr(): number {
  try {
    const p = globalThis.performance
    if (p !== undefined && typeof p.timeOrigin === 'number' && typeof p.now === 'function') {
      return p.timeOrigin + p.now()
    }
  } catch {
    // fall through
  }
  return Date.now()
}

function randomEpoch(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

function sanitize(fields: Record<string, unknown>): Record<string, TraceFieldValue> {
  const out: Record<string, TraceFieldValue> = {}
  for (const [k, v] of Object.entries(fields)) {
    if (k === 'seq' || k === 'type' || k === 'at' || k === 'atHr') continue
    if (v === null || typeof v === 'boolean') out[k] = v
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v
    else if (typeof v === 'string') out[k] = v.slice(0, MAX_STRING)
  }
  return out
}

/** Parse a stored value into a TraceStore, or null when absent / malformed. */
export function parseTraceStore(raw: unknown): TraceStore | null {
  if (raw === null || typeof raw !== 'object') return null
  const r = raw as Partial<TraceStore>
  if (
    r.v !== 1 ||
    typeof r.epoch !== 'string' ||
    typeof r.initAt !== 'string' ||
    typeof r.nextSeq !== 'number' ||
    typeof r.dropped !== 'number' ||
    !Array.isArray(r.events)
  ) {
    return null
  }
  return {
    v: 1,
    epoch: r.epoch,
    initAt: r.initAt,
    nextSeq: r.nextSeq,
    dropped: r.dropped,
    events: r.events.filter(
      (e): e is TraceEvent =>
        e !== null && typeof e === 'object' && typeof (e as TraceEvent).seq === 'number',
    ),
  }
}

let chain: Promise<unknown> = Promise.resolve()

function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = (globalThis.navigator as { locks?: LockManager } | undefined)?.locks
  if (locks !== undefined && typeof locks.request === 'function') {
    return locks.request(LOCK_NAME, fn) as Promise<T>
  }
  const run = chain.then(fn)
  chain = run.catch(() => undefined)
  return run
}

function append(
  store: TraceStore,
  type: string,
  instant: number,
  fields: Record<string, TraceFieldValue>,
): TraceStore {
  const event: TraceEvent = {
    ...fields,
    seq: store.nextSeq,
    type,
    at: new Date(Math.floor(instant)).toISOString(),
    atHr: instant,
  }
  const events = [...store.events, event]
  const overflow = Math.max(0, events.length - MAX_TRACE_EVENTS)
  return {
    ...store,
    nextSeq: store.nextSeq + 1,
    dropped: store.dropped + overflow,
    events: overflow > 0 ? events.slice(overflow) : events,
  }
}

/**
 * Append one event and persist it before returning (callers `await` this, so a
 * pre-request event is durable before the request goes out). The first write
 * creates the store with a `trace-init` event at seq 1. Returns the event's seq,
 * or null if storage failed (instrumentation never breaks the caller).
 *
 * `instant` (high-res epoch ms) lets a caller record the time something
 * HAPPENED (e.g. a response's receipt) rather than the time it was logged.
 */
export function traceEvent(
  type: string,
  fields: Record<string, unknown> = {},
  instant: number = nowHr(),
): Promise<number | null> {
  return withLock(async () => {
    try {
      const got = await chrome.storage.local.get(TEAMS_TRACE_KEY)
      let store = parseTraceStore(got[TEAMS_TRACE_KEY])
      if (store === null) {
        const initInstant = Math.min(instant, nowHr())
        store = append(
          {
            v: 1,
            epoch: randomEpoch(),
            initAt: new Date(Math.floor(initInstant)).toISOString(),
            nextSeq: 1,
            dropped: 0,
            events: [],
          },
          'trace-init',
          initInstant,
          {},
        )
      }
      const seq = store.nextSeq
      store = append(store, type, instant, sanitize(fields))
      await chrome.storage.local.set({ [TEAMS_TRACE_KEY]: store })
      return seq
    } catch {
      return null
    }
  })
}

export type TraceIntegrityState = 'absent' | 'intact' | 'rolled-over' | 'inconsistent'

export interface TraceIntegrity {
  readonly state: TraceIntegrityState
  /** Human-readable meaning of `state`, for the export. */
  readonly meaning: string
  readonly epoch: string | null
  readonly initAt: string | null
  /** Total events ever written in this epoch (nextSeq - 1). */
  readonly written: number
  readonly retained: number
  /** Events lost to ring rollover (always the oldest, seqs 1..dropped). */
  readonly dropped: number
  readonly firstSeq: number | null
  readonly lastSeq: number | null
}

/**
 * Prove what an export's events represent. `intact`: every event ever written
 * is present (seq 1..N, starting with `trace-init`). `rolled-over`: the oldest
 * `dropped` events were evicted, everything after is contiguous. `absent`: no
 * store — nothing was ever traced, or the extension's storage was cleared.
 * `inconsistent`: a gap or mismatch — records are missing for an unknown reason.
 */
export function traceIntegrity(store: TraceStore | null): TraceIntegrity {
  if (store === null) {
    return {
      state: 'absent',
      meaning:
        'No trace store: no Teams lifecycle event was ever recorded in this profile, or its extension storage was cleared.',
      epoch: null,
      initAt: null,
      written: 0,
      retained: 0,
      dropped: 0,
      firstSeq: null,
      lastSeq: null,
    }
  }
  const written = store.nextSeq - 1
  const seqs = store.events.map((e) => e.seq)
  const firstSeq = seqs[0] ?? null
  const lastSeq = seqs[seqs.length - 1] ?? null
  const contiguous = seqs.every((s, i) => i === 0 || s === (seqs[i - 1] ?? 0) + 1)
  const consistent =
    contiguous &&
    seqs.length === written - store.dropped &&
    (seqs.length === 0 || (firstSeq === store.dropped + 1 && lastSeq === written))
  const base = {
    epoch: store.epoch,
    initAt: store.initAt,
    written,
    retained: seqs.length,
    dropped: store.dropped,
    firstSeq,
    lastSeq,
  }
  if (!consistent) {
    return {
      ...base,
      state: 'inconsistent',
      meaning: 'Sequence gap or count mismatch: some records are missing for an unknown reason.',
    }
  }
  if (store.dropped > 0) {
    return {
      ...base,
      state: 'rolled-over',
      meaning: `The oldest ${store.dropped} event(s) (seq 1..${store.dropped}) were evicted by the ${MAX_TRACE_EVENTS}-event ring; seq ${firstSeq ?? '-'}..${lastSeq ?? '-'} are complete.`,
    }
  }
  return {
    ...base,
    state: 'intact',
    meaning: `Complete: every event written since ${store.initAt} (seq 1..${written}) is present.`,
  }
}

/** Read the store (null when absent / unreadable). */
export async function readTraceStore(): Promise<TraceStore | null> {
  try {
    const got = await chrome.storage.local.get(TEAMS_TRACE_KEY)
    return parseTraceStore(got[TEAMS_TRACE_KEY])
  } catch {
    return null
  }
}

/** A short, one-way, NON-secret reference to a provisioning attempt, so its
 *  start and result events (and a reuse after restart) can be correlated without
 *  recording the attempt secret: the first 12 hex of SHA-256("alg-trace:" + id).
 *  A different domain prefix from the server-bound idempotency key. */
export async function attemptRef(attemptId: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`alg-trace:${attemptId}`),
  )
  return Array.from(new Uint8Array(digest).slice(0, 6), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('')
}
