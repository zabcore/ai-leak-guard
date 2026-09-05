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
import { setSubmitKillSwitch } from '../shared/storage'

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

// V1.2 M6 (v1.2.0) welcome-tab wiring.
//
// On a fresh install (NOT on update / browser update), open the
// zabcore.com welcome page in a new tab so the user sees the
// getting-started copy for document protection (which now defaults
// on, per the M6 flag flip). Fires exactly once — Chrome only
// emits `reason: 'install'` for the actual install event; a
// subsequent extension update fires `'update'` and a browser
// upgrade fires `'chrome_update'`, both of which we ignore.
//
// `chrome.tabs.create({url})` needs NO additional permission — the
// `tabs` permission is only required to READ existing tabs' urls
// or titles, and no host permission is needed to open an external
// URL. The manifest-permissions test asserts this by pinning the
// permissions list to `['storage']` (with `optional_permissions`
// + `optional_host_permissions` both empty).
//
// Best-effort: a rejected `tabs.create` (e.g., in some corporate
// managed contexts) logs a warning and moves on — the extension
// itself works whether or not the welcome tab opens.
export const WELCOME_URL =
  'https://zabcore.com/welcome?src=chrome_web_store&utm_source=chrome_web_store&utm_medium=extension&utm_campaign=install_v1_2&v=1.2'

/**
 * Extracted so tests can drive the handler without depending on
 * `chrome.runtime.onInstalled.addListener` firing. Exported ONLY
 * for the unit test — production wiring is the anonymous listener
 * registration below.
 */
export function handleInstalled(
  details: { reason: string },
  tabs: { create: (opts: { url: string }) => void | Promise<unknown> } | undefined,
): void {
  if (details.reason !== 'install') return
  if (!tabs || typeof tabs.create !== 'function') return
  try {
    const result = tabs.create({ url: WELCOME_URL })
    // `chrome.tabs.create` in MV3 returns a Promise; a rejected
    // promise on a managed device (or similar) would otherwise
    // become an unhandled rejection. Route it through the same
    // warning path the sync try/catch already uses.
    if (result && typeof (result as Promise<unknown>).then === 'function') {
      void (result as Promise<unknown>).catch((err: unknown) => {
        console.warn('[AI Leak Guard] welcome tab failed to open:', err)
      })
    }
  } catch (err) {
    console.warn('[AI Leak Guard] welcome tab failed to open:', err)
  }
}

chrome.runtime.onInstalled.addListener((details) => {
  handleInstalled(details, chrome.tabs)
})

// ─── V1.3 M2 — submit-protection kill switch: clear on startup ──────
//
// M1 defined `submitKillSwitch` in storage; the core writes it when
// an adapter's `resume()` fails `RESUME_FAILURE_KILL_THRESHOLD` times
// in a row (surfaced as a popup notice), and the adapter stands down
// for the rest of the browser session. That disable MUST be
// session-scoped: without a clear, one transient resume failure would
// leave the popup showing "paused" across restarts forever.
//
// `chrome.runtime.onStartup` fires once per browser launch — NOT on
// every MV3 service-worker respawn — so clearing here re-arms
// protection at each new session while leaving a mid-session disable
// intact (the disable itself lives in the content script's in-memory
// core, which dies with the tab anyway; this storage key is only the
// cross-tab popup signal). We also clear on install/update. This
// lands NOW, before the flag is ever turned on, so the very first
// flag-on session starts from a clean slate.
//
// Best-effort and DOM-free (safe for the service worker): a rejected
// storage write logs and moves on.
function clearSubmitKillSwitchOnStartup(): void {
  try {
    void setSubmitKillSwitch(null).catch((err: unknown) => {
      console.warn('[AI Leak Guard] failed to clear submit kill switch:', err)
    })
  } catch (err) {
    console.warn('[AI Leak Guard] failed to clear submit kill switch:', err)
  }
}

chrome.runtime.onStartup.addListener(() => {
  clearSubmitKillSwitchOnStartup()
})

// onInstalled already fires above for the welcome tab; clear the kill
// switch on install/update too so an update never inherits a stale
// paused state.
chrome.runtime.onInstalled.addListener(() => {
  clearSubmitKillSwitchOnStartup()
})
