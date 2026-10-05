// Teams Lite (deployment m1) — staff-invitation join, extension side
// (Contract A §4c, attempt-bound / PKCE-style; transport per bridge/1.1.0 §3).
//
//   1. prepareChallenge() — on the page's `hello`: mint + PERSIST the attempt
//                           secret for that invitation, derive the challenge, and
//                           return ONLY the challenge. No network. A reconnect for
//                           an in-flight attempt re-emits the SAME challenge.
//   2. (website)          — the backend binds an exchange_token to that challenge
//                           and the page posts it back with `challenge_nonce`.
//   3. exchangeJoin()     — the token must echo a challenge nonce this extension
//                           emitted; persist it on the attempt, then POST /join
//                           {exchange_token, attempt_secret, idempotency_key}. The
//                           secret goes to the backend only.
//
// Lost-response recovery: on a network failure the attempt (with its exchange
// token) is KEPT, and every retry re-sends the SAME attempt. Per the
// recovery-ordering rule the backend answers a valid retry of a completed join
// with the existing credential even if the token was consumed/expired, so the
// stored token is preferred over any newer one the page offers. A settled join
// (success or terminal failure) keeps its bridge `result` for the replay window
// so a repeat `exchange_token` after a reconnect gets the same answer.
// Code-entry enrollment (`runEnroll`) stays as the fallback.

import { getBackendConfig } from './teams-config'
import {
  commitEnrollment,
  getEnrollment,
  getRevokeBlock,
  setRevokedNotice,
  setRevokeBlock,
} from '../shared/teams-storage'
import {
  JOIN_RESULT_REPLAY_MS,
  addDeadInvitation,
  clearJoinAttempt,
  getDeadInvitationCode,
  isDeadInvitationCode,
  deriveChallenge,
  getJoinAttempt,
  getJoinResult,
  isJoinResultLive,
  newAttemptSecret,
  setJoinAttempt,
  setJoinResult,
  withNonce,
  type JoinAttempt,
  type JoinResultPayload,
} from '../shared/teams-join-attempt'
import { deriveIdempotencyKey } from '../shared/teams-contract'
import type { join as joinFn } from './teams-client'

export type JoinRunOutcome =
  | 'enrolled'
  | 'already-enrolled'
  | 'not-configured'
  | 'no-attempt'
  | 'no-exchange-token'
  | 'invalid-proof'
  | 'expired'
  | 'install-revoked'
  | 'recovery-expired'
  | 'invitation-dead'
  | 'network'

/** bridge/1.1.0 §3 `presence.state` (pinned). */
export type JoinPresenceState = 'idle' | 'awaiting_token' | 'connecting' | 'connected' | 'error'

/** What the extension answers a `hello` with after `presence`. */
export type HelloOutcome =
  | { readonly kind: 'challenge'; readonly attempt_challenge: string; readonly expires_at: string }
  | { readonly kind: 'result'; readonly result: JoinResultPayload }

export interface JoinDeps {
  /** Injectable client loader (default: dynamic import of the egress chunk; the
   *  service worker passes its static client). */
  readonly loadClient?: () => Promise<{ join: typeof joinFn }>
  /** Injectable secret generator (tests). */
  readonly newSecret?: () => string
  /** Injectable clock (tests). */
  readonly now?: () => number
}

/** How long an unsent challenge stays offered before a new `hello` mints a
 *  fresh attempt (an attempt whose token was already sent is never replaced). */
export const JOIN_CHALLENGE_TTL_MS = JOIN_RESULT_REPLAY_MS

const defaultLoadClient = (): Promise<{ join: typeof joinFn }> => import('./teams-client')

const failed = (error_code: string): JoinResultPayload => ({ status: 'failed', error_code })

// Every read-modify-write of the join state runs through ONE chain, so a
// `hello`, an `exchange_token` and a startup recovery can never interleave.
let queue: Promise<unknown> = Promise.resolve()
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn)
  queue = run.catch(() => undefined)
  return run
}

/**
 * bridge/1.1.0 §3 `presence.state` for this install:
 * - `connected`      — enrolled;
 * - `connecting`     — an attempt whose exchange_token was sent (in flight or
 *                      awaiting lost-response recovery);
 * - `awaiting_token` — an attempt whose challenge is out, no token yet;
 * - `error`          — revoked install, or the last join failed (within the
 *                      replay window) and nothing newer is in progress;
 * - `idle`           — none of the above.
 */
export async function joinPresenceState(
  deps: Pick<JoinDeps, 'now'> = {},
): Promise<JoinPresenceState> {
  if ((await getEnrollment()) !== null) return 'connected'
  const attempt = await getJoinAttempt()
  if (attempt !== null) return attempt.exchangeToken !== undefined ? 'connecting' : 'awaiting_token'
  if (await getRevokeBlock()) return 'error'
  const settled = await getJoinResult()
  if (
    settled !== null &&
    settled.result.status === 'failed' &&
    isJoinResultLive(settled, (deps.now ?? Date.now)())
  ) {
    return 'error'
  }
  return 'idle'
}

/**
 * Answer a `hello` for `invitationRef`. `challengeNonce` is the envelope nonce
 * the caller will emit the challenge under; it is persisted BEFORE the challenge
 * leaves the extension so a later `exchange_token` can be correlated to it.
 *
 * - A SUCCESSFUL join for the same invitation (within the replay window)
 *   re-emits its challenge, so the page can replay its `exchange_token` and get
 *   the same result (a completed join is recovered, never re-joined).
 * - Already enrolled → a `failed already_enrolled` result for THIS invitation;
 *   the connected clinic is never switched silently.
 * - A revoked install, or an invitation that ended in `install_revoked` /
 *   `recovery_window_expired`, NEVER gets a fresh attempt (authorized recovery
 *   only): the failure is answered again instead.
 * - An attempt whose token was already sent is reused with the SAME challenge
 *   (never a new attempt because the port dropped, never replaced).
 * - An unsent attempt is reused while its challenge is live; once it ages out,
 *   or for another invitation, a new `hello` supersedes it.
 * - A fresh attempt for the same invitation after a failure is therefore only
 *   possible when that failure was non-recoverable but did not end the
 *   invitation (`expired`, `invalid_proof`). Whether the invitation is still
 *   redeemable is then decided by the backend at `/join-init` (the final guard
 *   against double redemption); this extension never retries on its own.
 */
export function prepareChallenge(
  invitationRef: string,
  challengeNonce: string,
  deps: JoinDeps = {},
): Promise<HelloOutcome> {
  return serial(async () => {
    const now = (deps.now ?? Date.now)()

    const settled = await getJoinResult()
    if (
      settled !== null &&
      settled.result.status === 'success' &&
      settled.invitationRef === invitationRef &&
      isJoinResultLive(settled, now)
    ) {
      await setJoinResult({
        ...settled,
        challengeNonces: withNonce(settled.challengeNonces, challengeNonce),
      })
      const created = Date.parse(settled.attemptCreatedAt ?? settled.settledAt)
      return {
        kind: 'challenge',
        attempt_challenge: settled.challenge,
        expires_at: new Date(created + JOIN_CHALLENGE_TTL_MS).toISOString(),
      }
    }

    if ((await getEnrollment()) !== null)
      return { kind: 'result', result: failed('already_enrolled') }

    const existing = await getJoinAttempt()
    if (existing !== null) {
      const sameInvitation = existing.invitationRef === invitationRef
      if (existing.exchangeToken !== undefined) {
        // In flight: only its own invitation may resume it.
        if (!sameInvitation && existing.invitationRef !== undefined) {
          return { kind: 'result', result: failed('join_pending') }
        }
        return reuse(existing, invitationRef, challengeNonce)
      }
      if (sameInvitation && now < challengeExpiry(existing)) {
        return reuse(existing, invitationRef, challengeNonce)
      }
      // Unsent and stale, or for another invitation: replaced below.
    }

    // Never a FRESH attempt for a revoked install or a dead invitation.
    if (await getRevokeBlock()) return { kind: 'result', result: failed('install_revoked') }
    const dead = await getDeadInvitationCode(invitationRef)
    if (dead !== null) return { kind: 'result', result: failed(dead) }

    const attemptSecret = (deps.newSecret ?? newAttemptSecret)()
    const attempt: JoinAttempt = {
      attemptSecret,
      challenge: await deriveChallenge(attemptSecret),
      // Pinned: base64url(SHA-256("alg-join-idem:" + attempt secret)) — domain-tagged
      // so it never equals the S256 challenge the website holds.
      idempotencyKey: await deriveIdempotencyKey('join', attemptSecret),
      createdAt: new Date(now).toISOString(),
      invitationRef,
      challengeNonces: [challengeNonce],
    }
    // Persist BEFORE the challenge leaves the extension.
    await setJoinAttempt(attempt)
    return challengeOf(attempt)
  })
}

function challengeExpiry(attempt: JoinAttempt): number {
  const created = Date.parse(attempt.createdAt)
  return Number.isFinite(created) ? created + JOIN_CHALLENGE_TTL_MS : 0
}

function challengeOf(attempt: JoinAttempt): HelloOutcome {
  return {
    kind: 'challenge',
    attempt_challenge: attempt.challenge,
    expires_at: new Date(challengeExpiry(attempt)).toISOString(),
  }
}

async function reuse(
  attempt: JoinAttempt,
  invitationRef: string,
  challengeNonce: string,
): Promise<HelloOutcome> {
  const next: JoinAttempt = {
    ...attempt,
    invitationRef: attempt.invitationRef ?? invitationRef,
    challengeNonces: withNonce(attempt.challengeNonces, challengeNonce),
  }
  await setJoinAttempt(next)
  return challengeOf(next)
}

/**
 * Handle a W→E `exchange_token`. `challengeNonce` must echo the nonce of a
 * `challenge` this extension emitted: it binds the token to our attempt.
 * Idempotent per challenge nonce — a repeat returns the stored result, or
 * `recovery_window_expired` once the attempt is dead (or was never ours).
 */
export function exchangeJoin(
  exchangeToken: string,
  challengeNonce: string,
  deps: JoinDeps = {},
): Promise<ExchangeOutcome> {
  return serial(async () => {
    const now = (deps.now ?? Date.now)()
    const settled = await getJoinResult()
    if (settled !== null && settled.challengeNonces.includes(challengeNonce)) {
      return {
        result: isJoinResultLive(settled, now) ? settled.result : failed('recovery_window_expired'),
        enrolledNow: false,
      }
    }
    const attempt = await getJoinAttempt()
    if (attempt === null || !(attempt.challengeNonces ?? []).includes(challengeNonce)) {
      return { result: failed('recovery_window_expired'), enrolledNow: false }
    }

    const outcome = await runJoinOnce(exchangeToken, deps)
    const enrolledNow = outcome === 'enrolled'
    const after = await getJoinResult()
    if (after !== null && after.challengeNonces.includes(challengeNonce)) {
      return { result: after.result, enrolledNow }
    }
    return { result: failed(OUTCOME_ERROR_CODE[outcome]), enrolledNow }
  })
}

export interface ExchangeOutcome {
  readonly result: JoinResultPayload
  /** True only when THIS call enrolled the install (not for a replay). */
  readonly enrolledNow: boolean
}

/** bridge `result.error_code` for an outcome that left no settled record. */
const OUTCOME_ERROR_CODE: Record<JoinRunOutcome, string> = {
  enrolled: 'internal_error',
  'already-enrolled': 'already_enrolled',
  'not-configured': 'not_configured',
  'no-attempt': 'recovery_window_expired',
  'no-exchange-token': 'invalid_message',
  'invalid-proof': 'invalid_proof',
  expired: 'expired',
  'install-revoked': 'install_revoked',
  'recovery-expired': 'recovery_window_expired',
  'invitation-dead': 'invitation_consumed', // always settled with its exact code first
  // Same retryable bucket as the website's existing `backend_unavailable`.
  network: 'backend_unavailable',
}

/** True when a join was sent but its outcome is unknown (recover on startup). */
export async function hasPendingJoin(): Promise<boolean> {
  return (await getJoinAttempt())?.exchangeToken !== undefined
}

/** Redeem (or recover) the persisted attempt. Calls are QUEUED, not coalesced:
 *  each runs after the previous one with its own token, so a handoff arriving
 *  during a startup recovery isn't dropped; once one call enrolls, the
 *  enrollment check makes the later ones no-ops (no second request). */
export function runJoin(
  exchangeToken: string | undefined,
  deps: JoinDeps = {},
): Promise<JoinRunOutcome> {
  return serial(() => runJoinOnce(exchangeToken, deps))
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
    // Re-derived on every request, so a retry of the same attempt always carries
    // the same key (even for an attempt persisted by an older build).
    idempotency_key: await deriveIdempotencyKey('join', attempt.attemptSecret),
  })
  const settledAt = new Date((deps.now ?? Date.now)()).toISOString()

  if (result.ok) {
    // INVARIANT (storage layer): a fresh credential never overwrites another
    // install's enrollment — a competing tab, a racing code-entry enroll or a
    // different invitation is refused at the store itself.
    const stored = await commitEnrollment({
      install_id: result.data.install_id,
      install_credential: result.data.install_credential,
      org_id: result.data.org_id,
      org_name: result.data.org_name,
      base_url: config.baseUrl,
    })
    if (!stored.ok) {
      await settle(attempt, settledAt, failed('already_enrolled'))
      return 'already-enrolled'
    }
    await setRevokedNotice(false)
    await settle(attempt, settledAt, {
      status: 'success',
      connected_invitation_ref: attempt.invitationRef ?? '',
      connected_attempt_challenge: attempt.challenge,
      connected_org_id: result.data.org_id,
      connected_org_name: result.data.org_name,
      connected_at: settledAt,
    })
    return 'enrolled'
  }

  switch (result.code) {
    case 'network':
      return 'network' // keep the attempt (and its token) for a retry
    case 'expired':
      // Only the exchange token lapsed (contract v1.1.1): RECOVERABLE. Keep the
      // SAME attempt and challenge, drop the dead token, so the page can mint a
      // new token for this challenge and the same secret redeems it. (A
      // completed join would have been recovered by the backend first.)
      await setJoinAttempt(withoutExchangeToken(attempt))
      return 'expired'
    case 'invalid_proof':
      await settle(attempt, settledAt, failed(result.code))
      return 'invalid-proof'
    case 'install_revoked':
      await settle(attempt, settledAt, failed(result.code))
      // This install was revoked: never let a managed policy silently re-enroll
      // it (same persistent block as /provision install_revoked).
      await setRevokeBlock()
      return 'install-revoked'
    case 'recovery_window_expired':
      await settle(attempt, settledAt, failed(result.code))
      return 'recovery-expired'
    case 'invitation_revoked':
    case 'invitation_expired':
    case 'invitation_consumed':
      // The invitation is dead: never retry it (no fresh attempt either). This
      // is NOT an install revocation — no re-enroll block.
      await settle(attempt, settledAt, failed(result.code))
      return 'invitation-dead'
  }
}

function withoutExchangeToken(attempt: JoinAttempt): JoinAttempt {
  const next: { -readonly [K in keyof JoinAttempt]: JoinAttempt[K] } = { ...attempt }
  delete next.exchangeToken
  return next
}

/** Keep the bridge result for replay, then drop the attempt (and its secret). */
async function settle(
  attempt: JoinAttempt,
  settledAt: string,
  result: JoinResultPayload,
): Promise<void> {
  await setJoinResult({
    ...(attempt.invitationRef !== undefined ? { invitationRef: attempt.invitationRef } : {}),
    challenge: attempt.challenge,
    attemptCreatedAt: attempt.createdAt,
    challengeNonces: attempt.challengeNonces ?? [],
    settledAt,
    result,
  })
  if (
    attempt.invitationRef !== undefined &&
    result.status === 'failed' &&
    isDeadInvitationCode(result.error_code)
  ) {
    await addDeadInvitation(attempt.invitationRef, result.error_code)
  }
  await clearJoinAttempt()
}
