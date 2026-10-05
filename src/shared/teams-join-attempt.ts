// Teams Lite (deployment m1) — the persisted join attempt (Contract A §4c).
//
// PKCE-style: before anything leaves the extension we mint a high-entropy
// attempt secret (the code-verifier) and derive the NON-secret challenge
// `base64url(SHA256(verifier))`. Only the challenge is handed to the website's
// verified join session; the backend binds the `exchange_token` to it. The
// secret stays here in `chrome.storage.local` and is sent only to the backend at
// `/join` — never to the website, a URL, or diagnostics.
//
// Persisting the attempt (and, before the first `/join`, the exchange token it is
// being redeemed with) lets a torn-down worker or a restart retry the SAME
// attempt, so a lost response is recovered rather than re-joined.

export const TEAMS_JOIN_ATTEMPT_KEY = 'teamsJoinAttempt'

export interface JoinAttempt {
  /** Code-verifier. SECRET — backend only. */
  readonly attemptSecret: string
  /** base64url(SHA256(attemptSecret)) — the only value given to the website. */
  readonly challenge: string
  /** base64url(SHA-256("alg-join-idem:" + attemptSecret)) — `deriveIdempotencyKey`. */
  readonly idempotencyKey: string
  readonly createdAt: string
  /** The invitation this attempt was minted for (bridge/1.1.0 `hello.invitation_ref`). */
  readonly invitationRef?: string
  /** Envelope nonces of every `challenge` emitted for this attempt (newest last,
   *  bounded). A W→E `exchange_token` must echo one of them as `challenge_nonce`. */
  readonly challengeNonces?: readonly string[]
  /** The bound exchange token, persisted before the first `/join` request. */
  readonly exchangeToken?: string
}

/** How many challenge-envelope nonces an attempt (or result) remembers. */
export const MAX_CHALLENGE_NONCES = 16

/** Append `nonce` to a bounded nonce list (oldest dropped first). */
export function withNonce(list: readonly string[] | undefined, nonce: string): string[] {
  const next = (list ?? []).filter((n) => n !== nonce)
  next.push(nonce)
  return next.slice(-MAX_CHALLENGE_NONCES)
}

function stringList(raw: unknown): string[] | undefined {
  return Array.isArray(raw) && raw.every((x) => typeof x === 'string')
    ? (raw as string[])
    : undefined
}

function base64url(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** 32 random bytes, base64url (43 chars) — RFC 7636 verifier-compatible. */
export function newAttemptSecret(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)))
}

/** S256 challenge: base64url(SHA256(utf8(verifier))). */
export async function deriveChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return base64url(new Uint8Array(digest))
}

export async function getJoinAttempt(): Promise<JoinAttempt | null> {
  try {
    const stored = await chrome.storage.local.get(TEAMS_JOIN_ATTEMPT_KEY)
    const raw = stored[TEAMS_JOIN_ATTEMPT_KEY] as Partial<JoinAttempt> | undefined
    if (
      raw === undefined ||
      raw === null ||
      typeof raw.attemptSecret !== 'string' ||
      typeof raw.challenge !== 'string' ||
      typeof raw.idempotencyKey !== 'string' ||
      typeof raw.createdAt !== 'string'
    ) {
      return null
    }
    return {
      attemptSecret: raw.attemptSecret,
      challenge: raw.challenge,
      idempotencyKey: raw.idempotencyKey,
      createdAt: raw.createdAt,
      ...(typeof raw.invitationRef === 'string' ? { invitationRef: raw.invitationRef } : {}),
      ...(stringList(raw.challengeNonces)
        ? { challengeNonces: stringList(raw.challengeNonces) }
        : {}),
      ...(typeof raw.exchangeToken === 'string' ? { exchangeToken: raw.exchangeToken } : {}),
    }
  } catch {
    return null
  }
}

export async function setJoinAttempt(value: JoinAttempt): Promise<void> {
  await chrome.storage.local.set({ [TEAMS_JOIN_ATTEMPT_KEY]: value })
}

export async function clearJoinAttempt(): Promise<void> {
  await chrome.storage.local.remove(TEAMS_JOIN_ATTEMPT_KEY)
}

// ─── Settled join result (bridge/1.1.0 §3 replay) ─────────────────────
//
// When a join settles (success or terminal failure) the attempt is cleared and
// the bridge `result` payload is kept here, together with the challenge nonces
// that may still be echoed, so a repeat `exchange_token` after a reconnect gets
// the SAME result (idempotent replay). Never holds the attempt secret or the
// install credential.

export const TEAMS_JOIN_RESULT_KEY = 'teamsJoinResult'
/** How long a settled result is replayed; afterwards the attempt is dead and a
 *  repeat gets `recovery_window_expired` (the backend's ~10-minute window). */
export const JOIN_RESULT_REPLAY_MS = 10 * 60 * 1000

export type JoinResultPayload =
  | {
      readonly status: 'success'
      readonly connected_invitation_ref: string
      readonly connected_attempt_challenge: string
      readonly connected_org_id: string
      readonly connected_org_name: string
      readonly connected_at: string
    }
  | { readonly status: 'failed'; readonly error_code: string }

export interface JoinResultRecord {
  readonly invitationRef?: string
  readonly challenge: string
  /** The settled attempt's creation time (drives the replayed `challenge.expires_at`). */
  readonly attemptCreatedAt?: string
  readonly challengeNonces: readonly string[]
  readonly settledAt: string
  readonly result: JoinResultPayload
}

export async function getJoinResult(): Promise<JoinResultRecord | null> {
  try {
    const stored = await chrome.storage.local.get(TEAMS_JOIN_RESULT_KEY)
    const raw = stored[TEAMS_JOIN_RESULT_KEY] as Partial<JoinResultRecord> | undefined
    const nonces = stringList(raw?.challengeNonces)
    if (
      raw === undefined ||
      raw === null ||
      typeof raw.challenge !== 'string' ||
      typeof raw.settledAt !== 'string' ||
      nonces === undefined ||
      raw.result === null ||
      typeof raw.result !== 'object'
    ) {
      return null
    }
    return {
      ...(typeof raw.invitationRef === 'string' ? { invitationRef: raw.invitationRef } : {}),
      challenge: raw.challenge,
      ...(typeof raw.attemptCreatedAt === 'string'
        ? { attemptCreatedAt: raw.attemptCreatedAt }
        : {}),
      challengeNonces: nonces,
      settledAt: raw.settledAt,
      result: raw.result as JoinResultPayload,
    }
  } catch {
    return null
  }
}

export async function setJoinResult(value: JoinResultRecord): Promise<void> {
  await chrome.storage.local.set({ [TEAMS_JOIN_RESULT_KEY]: value })
}

/** True while a settled result may still be replayed. */
export function isJoinResultLive(record: JoinResultRecord, now: number): boolean {
  const at = Date.parse(record.settledAt)
  return Number.isFinite(at) && now - at <= JOIN_RESULT_REPLAY_MS
}

// ─── Invitations that may never get a fresh attempt ───────────────────
//
// bridge/1.1.0: `install_revoked` and `recovery_window_expired` never yield a
// fresh attempt for that invitation — only authorized recovery can. Remembered
// durably (beyond the result replay window), bounded, invitation ref → code.

export const TEAMS_JOIN_DEAD_INVITATIONS_KEY = 'teamsJoinDeadInvitations'
export const MAX_DEAD_INVITATIONS = 32
export type DeadInvitationCode = 'install_revoked' | 'recovery_window_expired'

export async function getDeadInvitationCode(
  invitationRef: string,
): Promise<DeadInvitationCode | null> {
  try {
    const stored = await chrome.storage.local.get(TEAMS_JOIN_DEAD_INVITATIONS_KEY)
    const raw = stored[TEAMS_JOIN_DEAD_INVITATIONS_KEY] as unknown
    if (!Array.isArray(raw)) return null
    for (const entry of raw as Array<{ ref?: unknown; code?: unknown }>) {
      if (
        entry?.ref === invitationRef &&
        (entry.code === 'install_revoked' || entry.code === 'recovery_window_expired')
      ) {
        return entry.code
      }
    }
    return null
  } catch {
    return null
  }
}

export async function addDeadInvitation(
  invitationRef: string,
  code: DeadInvitationCode,
): Promise<void> {
  const stored = await chrome.storage.local.get(TEAMS_JOIN_DEAD_INVITATIONS_KEY)
  const raw = stored[TEAMS_JOIN_DEAD_INVITATIONS_KEY] as unknown
  const list = (Array.isArray(raw) ? (raw as Array<{ ref?: unknown }>) : []).filter(
    (e) => e?.ref !== invitationRef,
  )
  list.push({ ref: invitationRef, code } as { ref: string; code: DeadInvitationCode })
  await chrome.storage.local.set({
    [TEAMS_JOIN_DEAD_INVITATIONS_KEY]: list.slice(-MAX_DEAD_INVITATIONS),
  })
}
