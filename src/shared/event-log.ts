// V1.2 A5 (#40) local metadata-only event log — content-script API.
//
// Public surface stays the same:
//   • `AlgEvent` / `AlgAction` / `AlgEventType` / `MAX_EVENTS` types.
//   • `appendEvent(event)` — best-effort emit; NEVER throws.
//   • `getEvents()` — read-only fetch for the popup.
//   • `summariseEvents(events)` — pure roll-up for the popup.
//
// A5.1 (post-CR) change: writes are no longer performed inside
// this module. Each content-script context has its own module
// instance and its own `writeChain` closure — two tabs appending
// at the same time would each `get` the same array, `push`, and
// `set`, and the last writer would silently overwrite the other.
// Extension service workers are a single Chrome-wide instance;
// funnelling writes through `chrome.runtime.sendMessage` and
// having the service worker do the read-modify-write is the only
// way to actually serialise across tabs. See
// `src/background/service-worker.ts` for the receiver + the
// allowlist projection at the choke point.
//
// The moat rule is still enforced HERE too: we project the event
// through `projectAlgEvent` before sending, so a hostile /
// accidental extra field can't even leave the content script.
// The service worker projects again on receipt — belt-and-braces
// at both boundaries.

import { projectAlgEvent, isProjectedAlgEvent, type AlgEvent } from './event-log-schema'

export {
  MAX_EVENTS,
  type AlgEvent,
  type AlgAction,
  type AlgEventType,
  isProjectedAlgEvent,
  projectAlgEvent,
} from './event-log-schema'

const STORAGE_KEY = 'events'
const APPEND_MESSAGE_TYPE = 'alg-event-append'

/**
 * Read all persisted events. Kept as a plain `chrome.storage.local.get`
 * because the popup's read path is single-instance (only one popup
 * open at a time) and idempotent — no race concerns on the read
 * side. Every record is re-projected through the allowlist on
 * read too, so a polluted historical entry (edited at
 * chrome://extensions, or written by a pre-projection build)
 * cannot leak content into the popup DOM.
 */
export async function getEvents(): Promise<readonly AlgEvent[]> {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY)
    const raw = stored[STORAGE_KEY]
    if (!Array.isArray(raw)) return []
    const out: AlgEvent[] = []
    for (const entry of raw) {
      if (!isProjectedAlgEvent(entry)) continue
      try {
        out.push(projectAlgEvent(entry))
      } catch {
        // Projection failure on a record that PASSED the predicate
        // shouldn't happen, but silently drop just in case.
      }
    }
    return out
  } catch (err) {
    console.warn('[AI Leak Guard] event log read failed:', err)
    return []
  }
}

/**
 * Best-effort append. Projects the event through the allowlist
 * (drops any content-shaped stray fields BEFORE they cross the
 * message boundary), then posts a `chrome.runtime.sendMessage`
 * to the service worker which performs the actual serialised
 * read-modify-write.
 *
 * NEVER throws. A projection failure, an unreachable service
 * worker, or a `sendMessage` rejection all just log a warning —
 * the paste / document flow continues unaffected.
 *
 * Returns a promise so callers CAN await for testing purposes;
 * production code paths `void` the return value and don't gate on
 * it.
 */
export async function appendEvent(rawEvent: AlgEvent): Promise<void> {
  let projected: AlgEvent
  try {
    projected = projectAlgEvent(rawEvent)
  } catch (err) {
    console.warn('[AI Leak Guard] event log: rejected malformed event:', err)
    return
  }
  try {
    // `sendMessage` throws synchronously if `chrome.runtime` is
    // unavailable (e.g., during teardown), and rejects async on
    // "receiving end does not exist" if the service worker isn't
    // ready. Both are best-effort — swallow either.
    await sendAppendRequest(projected)
  } catch (err) {
    console.warn('[AI Leak Guard] event log append failed:', err)
  }
}

async function sendAppendRequest(event: AlgEvent): Promise<void> {
  // Guard against `chrome.runtime` being undefined — the shim in
  // `tests/setup.ts` only wires `chrome.storage`, so a test that
  // uses the real `appendEvent` (rather than the direct
  // service-worker `appendOne`) needs a no-op path here. That's
  // the same posture the `chrome.runtime.getURL` guard in
  // `worker-url.ts` uses.
  const runtime = (globalThis as unknown as { chrome?: { runtime?: unknown } }).chrome?.runtime as
    | { sendMessage?: (msg: unknown) => Promise<unknown> }
    | undefined
  if (!runtime || typeof runtime.sendMessage !== 'function') {
    // No service worker to talk to. Nothing to do — the flow
    // continues; a future paste/upload will get through as soon
    // as messaging is back.
    return
  }
  await runtime.sendMessage({ type: APPEND_MESSAGE_TYPE, event })
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
 * side effects, no storage reads.
 *
 * "Detected" counts everything the extension REACTED to (i.e.,
 * all events except the auto-cleared clean-file case). This is
 * the number the popup surfaces first — the honest "the
 * extension saw something interesting" figure.
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

/**
 * Test seam retained for backwards compatibility with older
 * tests that reset the write chain. The chain moved to the
 * service worker in A5.1, so this is now a no-op on the
 * content-script side — kept exported so any lingering caller
 * doesn't error out at import time.
 */
export function __resetEventLogWriteChainForTests(): void {
  // no-op: writes are serialised in the service worker.
}
