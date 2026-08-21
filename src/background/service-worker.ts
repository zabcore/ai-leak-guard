// V1.2 A5 (#40) service worker.
//
// The service worker owns the ONLY writer of `chrome.storage.local`
// for the metadata event log (`events` key). Content scripts post
// `{type:'alg-event-append', event}` via `chrome.runtime.sendMessage`;
// this worker serialises the read-modify-write.
//
// Why the service worker and not each content script? Every open
// tab of an in-scope site (ChatGPT, Claude, …) instantiates its
// own copy of the content-script module graph, and each copy has
// its own `writeChain` closure. Two tabs appending an event at the
// same time would each `get` the same array, `push` their event,
// and `set` the whole array back — the LAST writer wins and the
// other event is silently lost. Extension service workers are a
// single Chrome-wide instance across ALL frames and tabs, so
// funnelling writes through this one process makes the read-
// modify-write serialisation actually mean something.
//
// Best-effort posture stays the same: `sendMessage` failures on
// the content-script side are swallowed, and this worker's async
// message handler catches anything the write path throws so a bad
// event can never crash the worker (which would tear down other
// unrelated extension state).

import {
  MAX_EVENTS,
  isProjectedAlgEvent,
  projectAlgEvent,
  type AlgEvent,
} from '../shared/event-log-schema'

console.log('[AI Leak Guard] service worker started')

const STORAGE_KEY = 'events'
const APPEND_MESSAGE_TYPE = 'alg-event-append'

/**
 * Wire-level shape of the append request. Kept in sync with
 * `event-log.ts`'s `sendAppendRequest` — a mismatch would show up
 * as an ignored message (the type guard below rejects and
 * `sendResponse` short-circuits).
 */
interface AppendRequest {
  readonly type: typeof APPEND_MESSAGE_TYPE
  readonly event: unknown
}

function isAppendRequest(x: unknown): x is AppendRequest {
  if (x === null || typeof x !== 'object') return false
  const r = x as Record<string, unknown>
  return r.type === APPEND_MESSAGE_TYPE && 'event' in r
}

// Serialise every write through a single promise chain so a burst
// of tabs firing `sendMessage` at once still funnels through one
// read-modify-write at a time. Chrome's async message queue can
// deliver messages concurrently to this listener — without the
// chain the `get`/`set` pair inside `appendOne` would race even
// though there's only one worker instance.
let writeChain: Promise<void> = Promise.resolve()

async function appendOne(rawEvent: unknown): Promise<void> {
  // Project the incoming event through the schema allowlist BEFORE
  // anything else — this is the single choke point that keeps a
  // hostile / accidental extra field (`value`, `text`, `filename`,
  // …) from landing in storage. `projectAlgEvent` throws on
  // invalid shape; we swallow that here so a malformed message
  // never breaks the append chain.
  let event: AlgEvent
  try {
    event = projectAlgEvent(rawEvent)
  } catch (err) {
    console.warn('[AI Leak Guard] event-log: dropped malformed append request:', err)
    return
  }
  const stored = await chrome.storage.local.get(STORAGE_KEY)
  const raw = stored[STORAGE_KEY]
  const current: AlgEvent[] = Array.isArray(raw)
    ? raw.filter(isProjectedAlgEvent).map(projectAlgEvent)
    : []
  const next =
    current.length >= MAX_EVENTS ? [...current.slice(-MAX_EVENTS + 1), event] : [...current, event]
  const trimmed = next.length > MAX_EVENTS ? next.slice(-MAX_EVENTS) : next
  await chrome.storage.local.set({ [STORAGE_KEY]: trimmed })
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!isAppendRequest(message)) return false
  // Serialise through the write chain. The listener MUST return
  // `true` synchronously to keep the message port alive for the
  // async `sendResponse`.
  const done = writeChain
    .then(() => appendOne(message.event))
    .catch((err) => {
      console.warn('[AI Leak Guard] event-log append failed in service worker:', err)
    })
  writeChain = done.then(
    () => undefined,
    () => undefined,
  )
  done.then(() => {
    try {
      sendResponse({ ok: true })
    } catch {
      // sendResponse can fail if the sender tab already closed —
      // that's fine, the write still landed.
    }
  })
  return true
})

export {}
