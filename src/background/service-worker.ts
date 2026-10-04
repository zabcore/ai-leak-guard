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
import { withLinkSource } from '../shared/link-source'
import { runCheckin } from '../enterprise/teams-service'
import { runManagedBootstrap } from '../enterprise/teams-bootstrap'
import * as teamsCheckinClient from '../enterprise/teams-client'
import { recordNextAttempt } from '../shared/teams-diag'
import { nextRetryPlan } from './teams-retry-plan'

console.log('[AI Leak Guard] service worker started')

const STORAGE_KEY = 'events'
const APPEND_MESSAGE_TYPE = 'alg-event-append'

// ─── Teams Lite (#78) — enrolled check-in scheduler ──────────────────
//
// Runs the managed-settings check-in in the background. Network is reached ONLY
// when enrolled: `runCheckin` returns before the client is used otherwise, so an
// unenrolled (Free) startup / alarm / content-nudge is network-silent. The
// network client is imported STATICALLY above — dynamic `import()` is disallowed
// in a ServiceWorkerGlobalScope by the HTML spec, which silently broke every
// worker-driven check-in before — and is wired in via `loadClient` so the worker
// path actually runs the request. Importing the client has NO network side
// effect; it only defines functions.
const TEAMS_CHECKIN_ALARM = 'alg-teams-checkin'
const TEAMS_RETRY_ALARM = 'alg-teams-retry'
const TEAMS_CHECKIN_PERIOD_MIN = 15
const TEAMS_CHECKIN_DELAY_MIN = 1
const TEAMS_CHECKIN_MESSAGE_TYPE = 'alg-teams-checkin'
const TEAMS_RETRY_COUNT_KEY = 'teamsRetryCount'
// Bounded backoff (minutes) for failed check-ins, capped at the steady period,
// and the pure "never postpone a pending retry" decision — see `teams-retry-plan`.

/** Static client wired into `runCheckin` for the worker (no dynamic import). The
 *  fetch inside runs ONLY when runCheckin decides to call it — i.e. enrolled. */
const swLoadClient = async (): Promise<{
  enroll: typeof teamsCheckinClient.enroll
  checkin: typeof teamsCheckinClient.checkin
}> => ({ enroll: teamsCheckinClient.enroll, checkin: teamsCheckinClient.checkin })

/** Create the steady alarm only if one isn't already scheduled — NEVER reset an
 *  existing alarm's countdown (recreating it each wake pinned cadence to ~1min). */
async function ensureCheckinAlarm(): Promise<void> {
  try {
    const existing = await chrome.alarms?.get(TEAMS_CHECKIN_ALARM)
    if (!existing) {
      chrome.alarms?.create(TEAMS_CHECKIN_ALARM, {
        delayInMinutes: TEAMS_CHECKIN_DELAY_MIN,
        periodInMinutes: TEAMS_CHECKIN_PERIOD_MIN,
      })
    }
  } catch (err) {
    console.warn('[AI Leak Guard] failed to ensure teams check-in alarm:', err)
  }
}

/** Remove ALL teams scheduling + retry state (unenrolled / revoked). */
async function clearCheckinSchedule(): Promise<void> {
  try {
    await chrome.alarms?.clear(TEAMS_CHECKIN_ALARM)
    await chrome.alarms?.clear(TEAMS_RETRY_ALARM)
    await chrome.storage.local.remove(TEAMS_RETRY_COUNT_KEY)
  } catch (err) {
    console.warn('[AI Leak Guard] failed to clear teams schedule:', err)
  }
}

async function getRetryCount(): Promise<number> {
  try {
    const got = await chrome.storage.local.get(TEAMS_RETRY_COUNT_KEY)
    const n = got[TEAMS_RETRY_COUNT_KEY]
    return typeof n === 'number' && n >= 0 ? n : 0
  } catch {
    return 0
  }
}

/**
 * Schedule one bounded backoff retry after a failed check-in — but NEVER postpone
 * an already-pending retry. Check-ins fire from several sources (periodic alarm,
 * retry alarm, content-nudge, post-enroll); while a retry is already scheduled it
 * is the soonest attempt, so an extra failing attempt must keep it rather than
 * replace it with a longer-delay alarm of the same name. `nextRetryPlan` holds
 * that decision (unit-tested in `teams-retry-plan`); here we only read whether a
 * retry alarm is pending and the current failure count, then apply it.
 */
async function scheduleRetry(): Promise<void> {
  try {
    const existing = await chrome.alarms?.get(TEAMS_RETRY_ALARM)
    const plan = nextRetryPlan(Boolean(existing), await getRetryCount())
    if (!plan.schedule) return
    chrome.alarms?.create(TEAMS_RETRY_ALARM, { delayInMinutes: plan.delayMin })
    await chrome.storage.local.set({ [TEAMS_RETRY_COUNT_KEY]: plan.nextCount })
  } catch (err) {
    console.warn('[AI Leak Guard] failed to schedule teams retry:', err)
  }
}

/** Clear the retry backoff after a success. */
async function clearRetry(): Promise<void> {
  try {
    await chrome.alarms?.clear(TEAMS_RETRY_ALARM)
    await chrome.storage.local.remove(TEAMS_RETRY_COUNT_KEY)
  } catch {
    // best-effort
  }
}

/** Diagnostics: record the soonest next scheduled attempt (steady OR retry). */
async function recordNextScheduledAttempt(): Promise<void> {
  try {
    const [main, retry] = await Promise.all([
      chrome.alarms?.get(TEAMS_CHECKIN_ALARM),
      chrome.alarms?.get(TEAMS_RETRY_ALARM),
    ])
    const times = [main?.scheduledTime, retry?.scheduledTime].filter(
      (t): t is number => typeof t === 'number',
    )
    await recordNextAttempt(times.length > 0 ? new Date(Math.min(...times)).toISOString() : null)
  } catch {
    // diagnostics best-effort
  }
}

/**
 * Run one check-in with the static client, then reconcile the schedule from the
 * outcome: keep the steady alarm while enrolled, back off on failure, send ONE
 * prompt acknowledgment after an apply, and cancel everything once revoked.
 * Awaiting this inside a listener keeps the worker alive until it settles.
 */
async function safeRunCheckin(reason: string): Promise<void> {
  let outcome: Awaited<ReturnType<typeof runCheckin>> | 'error'
  try {
    outcome = await runCheckin({ reason, loadClient: swLoadClient })
  } catch (err) {
    console.warn(`[AI Leak Guard] teams check-in (${reason}) failed:`, err)
    outcome = 'error'
  }

  try {
    switch (outcome) {
      case 'apply':
        await clearRetry()
        await ensureCheckinAlarm()
        // One prompt acknowledgment of the just-applied revision — don't wait a
        // full period. Bounded: the ack check-in reports the applied revision and
        // returns 'noop', so it never chains. 'ack' trigger shows in diagnostics.
        if (reason !== 'ack') {
          try {
            await runCheckin({ reason: 'ack', loadClient: swLoadClient })
          } catch (err) {
            console.warn('[AI Leak Guard] teams ack check-in failed:', err)
          }
        }
        break
      case 'noop':
        await clearRetry()
        await ensureCheckinAlarm()
        break
      case 'retain':
      case 'error':
        // Failure: keep the steady alarm AND add a bounded backoff retry so an
        // outage recovers on its own, without waiting a whole period.
        await ensureCheckinAlarm()
        await scheduleRetry()
        break
      case 'revoke':
        // Management is over: cancel ALL scheduling + any pending retry.
        await clearCheckinSchedule()
        break
      case 'skipped-unenrolled':
      case 'not_configured':
        // Not managed: no scheduling should linger (stays network-silent).
        await clearCheckinSchedule()
        break
    }
  } catch (err) {
    console.warn('[AI Leak Guard] teams schedule reconcile failed:', err)
  }

  await recordNextScheduledAttempt()
}

// ─── Teams Lite (deployment m1) — managed-policy bootstrap ────────────
//
// When an admin deploys the extension with a Chrome managed policy carrying a
// deployment token (`public/managed_schema.json`), an unenrolled browser
// exchanges it once for its own per-install credential. Every decision goes
// through `planManagedBootstrap` (via `runManagedBootstrap`): no policy ⇒ no
// network; autoEnroll:false ⇒ skip; already enrolled ⇒ skip (a changed token
// never moves a browser to another clinic); revoke-blocked ⇒ skip. Runs on
// startup, install, and whenever the managed policy changes. The provision
// client is the same STATIC import as check-in (no dynamic import in a worker).
const TEAMS_PROVISION_RETRY_ALARM = 'alg-teams-provision-retry'
const TEAMS_PROVISION_RETRY_COUNT_KEY = 'teamsProvisionRetryCount'

const swLoadProvisionClient = async (): Promise<{
  provision: typeof teamsCheckinClient.provision
}> => ({ provision: teamsCheckinClient.provision })

async function clearProvisionRetry(): Promise<void> {
  try {
    await chrome.alarms?.clear(TEAMS_PROVISION_RETRY_ALARM)
    await chrome.storage.local.remove(TEAMS_PROVISION_RETRY_COUNT_KEY)
  } catch {
    // best-effort
  }
}

/** Bounded backoff for a provision that failed on the network. The persisted
 *  attempt is reused on the retry, so a lost response never costs a 2nd slot. */
async function scheduleProvisionRetry(): Promise<void> {
  try {
    const existing = await chrome.alarms?.get(TEAMS_PROVISION_RETRY_ALARM)
    const got = await chrome.storage.local.get(TEAMS_PROVISION_RETRY_COUNT_KEY)
    const n = got[TEAMS_PROVISION_RETRY_COUNT_KEY]
    const plan = nextRetryPlan(Boolean(existing), typeof n === 'number' ? n : 0)
    if (!plan.schedule) return
    chrome.alarms?.create(TEAMS_PROVISION_RETRY_ALARM, { delayInMinutes: plan.delayMin })
    await chrome.storage.local.set({ [TEAMS_PROVISION_RETRY_COUNT_KEY]: plan.nextCount })
  } catch {
    // best-effort
  }
}

/**
 * Run the managed bootstrap and reconcile its retry alarm. Returns true when
 * this run enrolled the browser. Errors are logged by NAME only — never a
 * message that could carry a token or URL.
 */
async function safeManagedBootstrap(): Promise<boolean> {
  try {
    const result = await runManagedBootstrap({ loadClient: swLoadProvisionClient })
    if (result.action === 'provision' && result.outcome === 'network') {
      await scheduleProvisionRetry()
      return false
    }
    await clearProvisionRetry()
    return result.action === 'provision' && result.outcome === 'enrolled'
  } catch (err) {
    console.warn(
      '[AI Leak Guard] teams managed bootstrap failed:',
      err instanceof Error ? err.name : 'error',
    )
    return false
  }
}

/** Bootstrap outside startup/install (policy change, retry): on a fresh
 *  enrollment, run the first check-in right away so the check-in alarm exists
 *  and managed settings apply without waiting. */
async function bootstrapThenCheckin(): Promise<void> {
  if (await safeManagedBootstrap()) await safeRunCheckin('post-provision')
}

chrome.storage.onChanged?.addListener(async (_changes, areaName) => {
  if (areaName !== 'managed') return
  await bootstrapThenCheckin()
})

chrome.alarms?.onAlarm.addListener(async (alarm) => {
  // Async listener → Chrome keeps the worker alive until the check-in settles.
  if (alarm.name === TEAMS_CHECKIN_ALARM) await safeRunCheckin('alarm')
  else if (alarm.name === TEAMS_RETRY_ALARM) await safeRunCheckin('retry')
  else if (alarm.name === TEAMS_PROVISION_RETRY_ALARM) await bootstrapThenCheckin()
})

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
// V1.3.3: campaign/version refreshed for the release, and stamped with the
// content-free `alg_src=welcome` source label (see `link-source.ts`) so the
// future website can attribute the welcome-tab entry point. Still a
// `chrome.tabs.create` NAVIGATION on install — never a fetch — and protection
// stays ungated on it.
const WELCOME_BASE =
  'https://zabcore.com/welcome?src=chrome_web_store&utm_source=chrome_web_store&utm_medium=extension&utm_campaign=install_v1_3_3&v=1.3.3'
export const WELCOME_URL = withLinkSource(WELCOME_BASE, 'welcome')

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

chrome.runtime.onStartup.addListener(async () => {
  clearSubmitKillSwitchOnStartup()
  // Managed bootstrap first (a no-op without a policy), so a just-provisioned
  // browser's first check-in is this startup one.
  await safeManagedBootstrap()
  await safeRunCheckin('startup')
})

// onInstalled already fires above for the welcome tab; clear the kill
// switch on install/update too so an update never inherits a stale
// paused state.
chrome.runtime.onInstalled.addListener(async () => {
  clearSubmitKillSwitchOnStartup()
  await safeManagedBootstrap()
  await safeRunCheckin('install')
})

// The popup asks us to run a check-in immediately after a successful enroll so
// the managed configuration applies without waiting for the next alarm. We
// return `true` and `sendResponse` only AFTER the check-in settles — that keeps
// the message channel (and the worker) alive for the async fetch, instead of
// letting MV3 tear the worker down the moment this listener returns.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const msg = message as { type?: unknown; reason?: unknown } | null
  if (msg?.type === TEAMS_CHECKIN_MESSAGE_TYPE) {
    // The sender names what it is (diagnostics): 'content-nudge' from an AI-tab
    // heartbeat, 'post-enroll' from the just-enrolled popup. Default: post-enroll.
    const reason = typeof msg.reason === 'string' ? msg.reason : 'post-enroll'
    void safeRunCheckin(reason).then(() => {
      try {
        sendResponse({ ok: true })
      } catch {
        // the popup may have closed; the check-in still completed
      }
    })
    return true
  }
  return false
})

// ─── No top-level check-in (deliberate) ──────────────────────────────
//
// Every cold worker wake runs this module from the top FIRST, then dispatches
// the event that caused the wake (onAlarm / onStartup / onInstalled / onMessage).
// A top-level `safeRunCheckin` would therefore run on EVERY wake and, via the
// single-flight guard, coalesce the real event's run under a generic "sw-start"
// label — hiding whether delivery came from the alarm, a retry, or startup
// (exactly the trigger attribution the acceptance needs). So we do NOT check in
// at the top level. Instead:
//   • enroll            → onMessage('post-enroll')  [creates the alarm]
//   • periodic delivery → onAlarm('alarm')
//   • bounded retry     → onAlarm('retry')
//   • browser launch    → onStartup('startup')
//   • install/update    → onInstalled('install')
//   • AI-tab heartbeat  → onMessage('content-nudge')
//   • managed provision → storage.onChanged(managed) / provision-retry alarm
//                         ('post-provision'); on startup/install the bootstrap
//                         runs first and the normal check-in follows
// The alarm is persistent (created at enroll, survives restarts), so a bare
// chrome://extensions reload with no event still syncs on the next alarm fire.
// Top-level `await` is disallowed in a worker anyway, so there is no reliable
// way to run an awaited startup check-in here regardless.
