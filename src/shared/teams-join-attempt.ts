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
  readonly idempotencyKey: string
  readonly createdAt: string
  /** The bound exchange token, persisted before the first `/join` request. */
  readonly exchangeToken?: string
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
