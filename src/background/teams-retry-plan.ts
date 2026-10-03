// Teams Lite (#78) — pure retry-backoff planning for the check-in scheduler.
//
// Extracted from the service worker so the central rule — "an extra failed
// attempt must NEVER postpone an already-pending retry" — is unit-testable
// without a `chrome.alarms` mock. The service worker's `scheduleRetry` is a thin
// wrapper that reads whether a retry alarm is already pending and the current
// failure count, then applies this decision.
//
// Why the rule matters (observed in Check B): check-ins can fire from several
// sources (periodic alarm, retry alarm, content-nudge, post-enroll). While a
// backoff retry is already scheduled, a second failing attempt used to call
// `chrome.alarms.create(RETRY, …)` again with a LONGER delay (the failure count
// had grown), and because the alarm name is the same that REPLACED the pending,
// sooner retry with a later one — postponing recovery. Preserving the pending
// retry keeps recovery as prompt as the earliest scheduled attempt.

/** Bounded backoff (minutes) for failed check-ins, capped at the steady period. */
export const TEAMS_RETRY_BACKOFF_MIN = [1, 2, 5, 10, 15] as const

export type RetryPlan =
  | { readonly schedule: false }
  | { readonly schedule: true; readonly delayMin: number; readonly nextCount: number }

/**
 * Decide the next bounded backoff retry.
 *  - `retryPending` true → a retry alarm is already scheduled (it is the soonest
 *    attempt). Keep it; do not schedule another and do not advance the counter.
 *    → `{ schedule: false }`
 *  - otherwise → schedule the current backoff step and advance the counter.
 *
 * `count` is the number of backoff steps already taken (0 on the first failure).
 * A non-finite / negative count is treated as 0 so a corrupt stored value can
 * never pick an out-of-range delay.
 */
export function nextRetryPlan(retryPending: boolean, count: number): RetryPlan {
  if (retryPending) return { schedule: false }
  const safe = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0
  const idx = Math.min(safe, TEAMS_RETRY_BACKOFF_MIN.length - 1)
  return { schedule: true, delayMin: TEAMS_RETRY_BACKOFF_MIN[idx], nextCount: safe + 1 }
}
