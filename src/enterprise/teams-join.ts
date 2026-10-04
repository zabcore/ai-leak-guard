// Teams Lite (deployment m1) — staff-invitation join, extension side
// (Contract A §4c, attempt-bound / PKCE-style).
//
//   1. beginJoin()  — mint + PERSIST the attempt secret, derive the challenge,
//                     and return ONLY the challenge (for the website's verified
//                     join session). No network.
//   2. (website)    — the backend binds an exchange_token to that challenge and
//                     the page hands the token back through the handoff.
//   3. runJoin()    — persist the exchange token on the attempt, then POST /join
//                     {exchange_token, attempt_secret, idempotency_key} via the
//                     injectable client. The secret goes to the backend only.
//
// Lost-response recovery: on a network failure the attempt (with its exchange
// token) is KEPT, and every retry re-sends the SAME attempt. Per the
// recovery-ordering rule the backend answers a valid retry of a completed join
// with the existing credential even if the token was consumed/expired, so the
// stored token is preferred over any newer one the page offers. Terminal answers
// clear the attempt. Code-entry enrollment (`runEnroll`) stays as the fallback.

import { getBackendConfig } from './teams-config'
import { getEnrollment, setEnrollment, setRevokedNotice } from '../shared/teams-storage'
import {
  clearJoinAttempt,
  deriveChallenge,
  getJoinAttempt,
  newAttemptSecret,
  setJoinAttempt,
  type JoinAttempt,
} from '../shared/teams-join-attempt'
import type { join as joinFn } from './teams-client'

export type BeginJoinResult =
  | { readonly ok: true; readonly challenge: string }
  | { readonly ok: false; readonly error: 'already_enrolled' | 'join_pending' }

export type JoinRunOutcome =
  | 'enrolled'
  | 'already-enrolled'
  | 'not-configured'
  | 'no-attempt'
  | 'no-exchange-token'
  | 'invalid-proof'
  | 'expired'
  | 'revoked'
  | 'recovery-expired'
  | 'network'

export interface JoinDeps {
  /** Injectable client loader (default: dynamic import of the egress chunk; the
   *  service worker passes its static client). */
  readonly loadClient?: () => Promise<{ join: typeof joinFn }>
  /** Injectable secret generator (tests). */
  readonly newSecret?: () => string
  /** Injectable idempotency-key generator (tests). */
  readonly newId?: () => string
}

const defaultLoadClient = (): Promise<{ join: typeof joinFn }> => import('./teams-client')

/**
 * Start (or resume) a join: returns the NON-secret challenge for the website.
 * Reuses an unsent attempt so repeated page loads keep one secret; refuses while
 * a join for a previous exchange token is still pending recovery (the page
 * should call complete again, which retries that same attempt).
 */
export async function beginJoin(deps: JoinDeps = {}): Promise<BeginJoinResult> {
  if ((await getEnrollment()) !== null) return { ok: false, error: 'already_enrolled' }
  const existing = await getJoinAttempt()
  if (existing !== null) {
    if (existing.exchangeToken !== undefined) return { ok: false, error: 'join_pending' }
    return { ok: true, challenge: existing.challenge }
  }
  const attemptSecret = (deps.newSecret ?? newAttemptSecret)()
  const attempt: JoinAttempt = {
    attemptSecret,
    challenge: await deriveChallenge(attemptSecret),
    idempotencyKey: (deps.newId ?? (() => crypto.randomUUID()))(),
    createdAt: new Date().toISOString(),
  }
  // Persist BEFORE the challenge leaves the extension.
  await setJoinAttempt(attempt)
  return { ok: true, challenge: attempt.challenge }
}

/** True when a join was sent but its outcome is unknown (recover on startup). */
export async function hasPendingJoin(): Promise<boolean> {
  return (await getJoinAttempt())?.exchangeToken !== undefined
}

let inFlight: Promise<JoinRunOutcome> | null = null

/** Redeem (or recover) the persisted attempt. Serialized so a handoff message
 *  and a startup recovery can't race two requests. */
export function runJoin(
  exchangeToken: string | undefined,
  deps: JoinDeps = {},
): Promise<JoinRunOutcome> {
  inFlight ??= runJoinOnce(exchangeToken, deps).finally(() => {
    inFlight = null
  })
  return inFlight
}

async function runJoinOnce(
  offeredToken: string | undefined,
  deps: JoinDeps,
): Promise<JoinRunOutcome> {
  if ((await getEnrollment()) !== null) return 'already-enrolled'
  const config = getBackendConfig()
  if (config === null) return 'not-configured'

  let attempt = await getJoinAttempt()
  if (attempt === null) return 'no-attempt'

  // Recovery ordering: a token already persisted on the attempt wins (it may be
  // the one the backend already redeemed for this attempt).
  if (attempt.exchangeToken === undefined) {
    if (offeredToken === undefined || offeredToken === '') return 'no-exchange-token'
    attempt = { ...attempt, exchangeToken: offeredToken }
    await setJoinAttempt(attempt)
  }
  const exchangeToken = attempt.exchangeToken as string

  const { join } = await (deps.loadClient ?? defaultLoadClient)()
  const result = await join(config.baseUrl, config.anonKey, {
    exchange_token: exchangeToken,
    attempt_secret: attempt.attemptSecret,
    idempotency_key: attempt.idempotencyKey,
  })

  if (result.ok) {
    await setEnrollment({
      install_id: result.data.install_id,
      install_credential: result.data.install_credential,
      org_id: result.data.org_id,
      org_name: result.data.org_name,
      base_url: config.baseUrl,
    })
    await setRevokedNotice(false)
    await clearJoinAttempt()
    return 'enrolled'
  }

  if (result.code === 'network') return 'network' // keep the attempt for a retry
  await clearJoinAttempt()
  switch (result.code) {
    case 'invalid_proof':
      return 'invalid-proof'
    case 'expired':
      return 'expired'
    case 'revoked':
      return 'revoked'
    case 'recovery_window_expired':
      return 'recovery-expired'
  }
}
