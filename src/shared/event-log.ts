// V1.2 A5 (#40) local metadata-only event log.
//
// The moat rule (non-negotiable): the log stores **metadata only,
// never content.** No matched values, no masked/reconstructed text,
// no file text, no filenames. This is what keeps the extension's
// "ZabCore never receives patient content" claim honest AND is the
// exact event shape a future paid-tier dashboard would aggregate —
// so nothing has to change downstream when we ship that: the on-
// device schema is already free of content.
//
// The log lives in `chrome.storage.local` under a single key
// (`events`). It's a bounded ring buffer — new events append,
// the oldest is dropped when we cross `MAX_EVENTS`. `appendEvent`
// is documented never-throws: a storage failure logs a warning but
// must NOT reject up into the paste or document flow (the user's
// paste MUST land regardless of whether we could persist a
// metadata record about it).
//
// This module is the ONLY shared surface the paste + document
// paths use for logging. Callers pass in a fully-formed `AlgEvent`
// they built from the ALREADY-COMPUTED detection result / scan
// aggregate — the log never re-scans, never re-reads content, and
// never receives a value string in the first place.

import type { DetectorCategory } from '../detector/types'

/** Which decision path emitted the event. */
export type AlgEventType = 'paste' | 'document'

/**
 * What the user ended up doing.
 *
 * Paste path:
 *   • `protected`        — took the masked version of a detected paste
 *   • `as-is`            — pasted the original despite detection
 *   • `cancelled`        — cancelled the preview modal
 *
 * Document path:
 *   • `uploaded-anyway`  — released despite the sensitive warning
 *   • `cancelled`        — cancelled the document modal (any state)
 *   • `auto-cleared`     — clean file, auto-proceeded without a modal
 *   • `unable-to-inspect`— couldn't read the file to check it
 */
export type AlgAction =
  | 'protected'
  | 'as-is'
  | 'cancelled'
  | 'uploaded-anyway'
  | 'auto-cleared'
  | 'unable-to-inspect'

/**
 * One decision-point event. Fields are the ENTIRE persisted shape;
 * a `no-content` guard test asserts no `value` / `text` / `name` /
 * `filename` key is EVER written to storage.
 */
export interface AlgEvent {
  /** `Date.now()` at the moment of the decision. */
  readonly ts: number
  /** Site adapter id: `chatgpt` / `claude` / `gemini` / `perplexity`. */
  readonly site: string
  readonly eventType: AlgEventType
  readonly action: AlgAction
  /**
   * Distinct taxonomy categories DETECTED (post-`isMaskable`). Empty
   * for `auto-cleared` (clean file) and `unable-to-inspect` (nothing
   * to detect against). Never carries a raw value.
   */
  readonly categories: readonly DetectorCategory[]
  /** Number of maskable items detected. `0` for clean / unable. */
  readonly count: number
  /** Mirrors `DetectionResult.hasCriticalOrHigh` when available. */
  readonly hadCriticalOrHigh: boolean
}

/**
 * Ring-buffer cap. 200 is plenty for a "recent activity" popup
 * (weeks of typical use) and small enough that even the fattest
 * `AlgEvent` (~200 bytes) stays well under any `chrome.storage.local`
 * per-key quota. Trims the oldest first — the popup always shows
 * the tail.
 */
export const MAX_EVENTS = 200

const STORAGE_KEY = 'events'

/**
 * Read all persisted events. Callers should treat the returned
 * array as read-only. Never throws — a broken/absent record
 * degrades to `[]` so the popup renders an empty state instead of
 * a red banner.
 */
export async function getEvents(): Promise<readonly AlgEvent[]> {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY)
    const raw = stored[STORAGE_KEY]
    if (!Array.isArray(raw)) return []
    // Defensive filter: drop anything that doesn't look like an
    // AlgEvent. Guards against a future schema bump reading an old
    // shape, or a manual chrome://extensions storage edit.
    return raw.filter(isAlgEvent)
  } catch (err) {
    console.warn('[AI Leak Guard] event log read failed:', err)
    return []
  }
}

/**
 * Best-effort append. Reads the current buffer, appends, trims to
 * `MAX_EVENTS`, and writes back. Serialised through a single
 * promise chain so two concurrent appends can't clobber each
 * other's read-modify-write (same pattern `counter.ts` uses).
 *
 * NEVER throws into the caller. A storage failure logs a warning
 * and the paste / document flow continues unaffected. Callers
 * should still `void` the returned promise — awaiting it isn't
 * wrong, but no code path should gate on its outcome.
 */
export function appendEvent(event: AlgEvent): Promise<void> {
  return enqueueWrite(async () => {
    try {
      const current = await getEvents()
      const next: AlgEvent[] =
        current.length >= MAX_EVENTS ? current.slice(-MAX_EVENTS + 1) : [...current]
      next.push(event)
      // Belt-and-braces: after the (potential) trim + push, cap
      // again so a MAX_EVENTS bump doesn't accidentally let a
      // buggy caller write an unbounded array.
      const trimmed = next.length > MAX_EVENTS ? next.slice(-MAX_EVENTS) : next
      await chrome.storage.local.set({ [STORAGE_KEY]: trimmed })
    } catch (err) {
      // Deliberately swallowed. The paste/upload MUST proceed even
      // if we can't record a metadata note about it.
      console.warn('[AI Leak Guard] event log append failed:', err)
    }
  })
}

let writeChain: Promise<void> = Promise.resolve()
function enqueueWrite(op: () => Promise<void>): Promise<void> {
  const result = writeChain.then(op, op)
  writeChain = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

function isAlgEvent(x: unknown): x is AlgEvent {
  if (x === null || typeof x !== 'object') return false
  const r = x as Record<string, unknown>
  return (
    typeof r.ts === 'number' &&
    typeof r.site === 'string' &&
    (r.eventType === 'paste' || r.eventType === 'document') &&
    typeof r.action === 'string' &&
    Array.isArray(r.categories) &&
    typeof r.count === 'number' &&
    typeof r.hadCriticalOrHigh === 'boolean'
  )
}

/**
 * Aggregated counters the popup renders. Kept intentionally
 * small — anything the popup wants beyond this reads the raw
 * event list directly (for the recent-activity list) or derives
 * from these totals.
 */
export interface EventSummary {
  readonly total: number
  readonly detected: number
  readonly protectedCount: number
  readonly asIs: number
  readonly cancelled: number
  readonly uploadedAnyway: number
  readonly autoCleared: number
  readonly unableToInspect: number
  /** `{ chatgpt: N, claude: M, … }`. Empty on a fresh install. */
  readonly perSite: Readonly<Record<string, number>>
}

/**
 * Fold an event list into the popup's summary shape. Pure — no
 * side effects, no storage reads. Kept exported so tests can
 * feed in fabricated events and assert the derivation.
 *
 * "Detected" counts everything the extension REACTED to (i.e., all
 * events except the auto-cleared clean-file case). This is the
 * number the popup surfaces first — the honest "the extension saw
 * something interesting" figure.
 */
export function summariseEvents(events: readonly AlgEvent[]): EventSummary {
  const perSite: Record<string, number> = {}
  let protectedCount = 0
  let asIs = 0
  let cancelled = 0
  let uploadedAnyway = 0
  let autoCleared = 0
  let unableToInspect = 0
  for (const e of events) {
    perSite[e.site] = (perSite[e.site] ?? 0) + 1
    switch (e.action) {
      case 'protected':
        protectedCount += 1
        break
      case 'as-is':
        asIs += 1
        break
      case 'cancelled':
        cancelled += 1
        break
      case 'uploaded-anyway':
        uploadedAnyway += 1
        break
      case 'auto-cleared':
        autoCleared += 1
        break
      case 'unable-to-inspect':
        unableToInspect += 1
        break
    }
  }
  return {
    total: events.length,
    detected: events.length - autoCleared,
    protectedCount,
    asIs,
    cancelled,
    uploadedAnyway,
    autoCleared,
    unableToInspect,
    perSite,
  }
}

/** Test seam: forget the write chain so a failing test can't leak state. */
export function __resetEventLogWriteChainForTests(): void {
  writeChain = Promise.resolve()
}
