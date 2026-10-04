// Teams Lite (#78) — content-script heartbeat.
//
// Why this exists: an enrolled browser must pick up an admin's setting change
// WITHOUT the user opening the popup. The popup-open path (teams-ui) and the
// post-enroll nudge both work, but "truly in the background" was left to a
// periodic `chrome.alarms` check-in — and MV3 does not reliably wake a
// suspended service worker for a short-period alarm on every machine/power
// profile (observed: an idle worker that never re-fires). So background
// operation can't depend on the alarm alone.
//
// The reliable signal is the user actually USING a managed AI tool. The content
// script already runs on every managed host; here it simply nudges the service
// worker to check in when the browser lands on (or returns to) one of those
// tabs. Sending a runtime message WAKES a suspended worker, so this both wakes
// it and triggers the check-in — exactly when a current managed policy matters.
//
// Guardrails:
//  • Enrolled only. A Free user's visit does a single local storage read and
//    NOTHING else — no worker wake, no network. The backend is never contacted
//    for an unenrolled browser.
//  • Throttled (per-browser, storage-backed) so many tabs / rapid refocus can't
//    produce a check-in storm; the worker's own in-flight serialization
//    coalesces anything that still overlaps.

import { getEnrollment } from '../shared/teams-storage'
import {
  readDiag,
  TEAMS_DIAG_KEY,
  TEAMS_NEXT_ATTEMPT_KEY,
  TEAMS_DIAG_CONSOLE_PREFIX,
} from '../shared/teams-diag'

/** Must match the service worker's `TEAMS_CHECKIN_MESSAGE_TYPE`. */
const NUDGE_MESSAGE_TYPE = 'alg-teams-checkin'

/** Storage key for the last-nudge timestamp (per browser, shared across tabs). */
export const TEAMS_LAST_NUDGE_KEY = 'teamsLastNudgeAt'

/** At most one nudge per this window, however many tabs/refocus events fire. */
export const TEAMS_NUDGE_THROTTLE_MS = 60_000

async function millisSinceLastNudge(now: number): Promise<number> {
  try {
    const got = await chrome.storage.local.get(TEAMS_LAST_NUDGE_KEY)
    const last = got[TEAMS_LAST_NUDGE_KEY]
    return typeof last === 'number' && Number.isFinite(last) ? now - last : Number.POSITIVE_INFINITY
  } catch {
    // If storage can't be read, don't block the nudge — fail toward syncing.
    return Number.POSITIVE_INFINITY
  }
}

/**
 * Ask the service worker to check in now — but only for an enrolled browser,
 * and at most once per throttle window. Best-effort: never throws.
 */
export async function nudgeCheckin(): Promise<void> {
  try {
    // Enrolled browsers only. This is a local read — it does NOT wake the
    // worker, so a Free user's AI-tab visit stays silent.
    if ((await getEnrollment()) === null) return

    const now = Date.now()
    if ((await millisSinceLastNudge(now)) < TEAMS_NUDGE_THROTTLE_MS) return

    // Claim the throttle window BEFORE sending so concurrent tabs don't all
    // fire. A failed write just means we proceed (the worker coalesces).
    try {
      await chrome.storage.local.set({ [TEAMS_LAST_NUDGE_KEY]: now })
    } catch {
      // best-effort throttle
    }

    const maybePromise = chrome.runtime?.sendMessage?.({
      type: NUDGE_MESSAGE_TYPE,
      reason: 'content-nudge',
    }) as Promise<unknown> | undefined
    if (maybePromise && typeof maybePromise.then === 'function') {
      void maybePromise.catch(() => {
        // The worker may have torn down mid-send; its alarm/next visit retries.
      })
    }
  } catch {
    // never let a heartbeat failure surface into the content script
  }
}

/**
 * Wire the heartbeat. Called once at content-script init. Nudges on load (the
 * browser just landed on a managed AI tool) and on refocus (a long-open tab the
 * user returns to after an admin changed settings mid-session).
 */
export function startTeamsHeartbeat(): void {
  void nudgeCheckin()
  try {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void nudgeCheckin()
    })
  } catch {
    // no document (non-DOM context) — the load-time nudge above still ran
  }
  startTeamsDiagMirror()
}

/**
 * Instrumentation only: mirror the content-free check-in diagnostics buffer to
 * the page console (prefixed) on load and whenever it changes, so the background
 * scheduling behavior can be read during testing WITHOUT opening the popup.
 * Enrolled browsers only — a Free user's console stays quiet.
 */
export function startTeamsDiagMirror(): void {
  const dump = async (): Promise<void> => {
    try {
      if ((await getEnrollment()) === null) return
      const { attempts, nextAttemptAt } = await readDiag()
      console.log(TEAMS_DIAG_CONSOLE_PREFIX, JSON.stringify({ nextAttemptAt, attempts }))
    } catch {
      // best-effort
    }
  }
  void dump()
  try {
    chrome.storage?.onChanged?.addListener((changes, area) => {
      if (area !== 'local') return
      if (TEAMS_DIAG_KEY in changes || TEAMS_NEXT_ATTEMPT_KEY in changes) void dump()
    })
  } catch {
    // best-effort
  }
}
