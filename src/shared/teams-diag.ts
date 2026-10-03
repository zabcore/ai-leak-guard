// Teams Lite (#78) — check-in diagnostics (instrumentation ONLY, no behavior).
//
// A small, content-free ring buffer recording each check-in ATTEMPT so the
// background/scheduling behavior can be measured without guessing: what fired
// it, when, the result, and the revisions involved. It records NO prompt text,
// NO clipboard/document content, NO detection values, NO credentials — only the
// trigger label, timestamps, the outcome enum, and integer revision numbers.
//
// The service worker also records the next scheduled attempt (the check-in
// alarm's next fire time) so "did the scheduled path run / when is it next due"
// is observable. The content script mirrors this buffer to the page console
// (prefix below) so it can be read during testing without opening the popup.

export const TEAMS_DIAG_KEY = 'teamsCheckinDiag'
export const TEAMS_NEXT_ATTEMPT_KEY = 'teamsNextAttempt'
export const TEAMS_DIAG_CONSOLE_PREFIX = '[ALG-TEAMS-DIAG]'

/** Keep the buffer small — this is a rolling window for live testing. */
const MAX_ATTEMPTS = 40

/** One recorded check-in attempt. Content-free: labels, times, integers only. */
export interface CheckinAttempt {
  /** ISO time the attempt completed. */
  at: string
  /** What fired it: alarm | sw-start | startup | install | post-enroll | content-nudge | popup | unknown. */
  trigger: string
  /** The CheckinRunOutcome: skipped-unenrolled | not_configured | retain | noop | apply | revoke. */
  result: string
  /** applied_settings_revision SENT to the server (i.e. acknowledged). */
  reported: number | null
  /** target_settings_revision RECEIVED (null when no 2xx response / revoked). */
  received: number | null
  /** applied revision AFTER this attempt. */
  applied: number | null
  /** Short, content-free error label when the attempt threw (e.g. "TypeError").
   *  Never a request body, URL, or credential. Absent on success. */
  error?: string
}

/** Append one attempt to the ring buffer. Best-effort — never throws. */
export async function recordCheckinAttempt(entry: CheckinAttempt): Promise<void> {
  try {
    const got = await chrome.storage.local.get(TEAMS_DIAG_KEY)
    const raw = got[TEAMS_DIAG_KEY]
    const current = Array.isArray(raw) ? (raw as CheckinAttempt[]) : []
    const next = [...current, entry].slice(-MAX_ATTEMPTS)
    await chrome.storage.local.set({ [TEAMS_DIAG_KEY]: next })
  } catch {
    // diagnostics must never affect the check-in itself
  }
}

/** Record the next scheduled check-in attempt (the alarm's next fire). */
export async function recordNextAttempt(atIso: string | null): Promise<void> {
  try {
    await chrome.storage.local.set({ [TEAMS_NEXT_ATTEMPT_KEY]: atIso })
  } catch {
    // best-effort
  }
}

/** Read the buffer + the next scheduled attempt (for the console mirror). */
export async function readDiag(): Promise<{
  attempts: CheckinAttempt[]
  nextAttemptAt: string | null
}> {
  try {
    const got = await chrome.storage.local.get([TEAMS_DIAG_KEY, TEAMS_NEXT_ATTEMPT_KEY])
    const raw = got[TEAMS_DIAG_KEY]
    const nextRaw = got[TEAMS_NEXT_ATTEMPT_KEY]
    return {
      attempts: Array.isArray(raw) ? (raw as CheckinAttempt[]) : [],
      nextAttemptAt: typeof nextRaw === 'string' ? nextRaw : null,
    }
  } catch {
    return { attempts: [], nextAttemptAt: null }
  }
}
