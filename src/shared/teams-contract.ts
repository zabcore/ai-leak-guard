// Teams Lite (Checkpoint 1) — the enroll / check-in WIRE CONTRACT.
//
// These types mirror the backend edge functions verbatim (issue #78). They live
// in `shared` (no `fetch`, no `chrome`) so both the content-free payload builder
// and the pure state machine can be unit-tested, and so the free path can import
// the *types* without ever loading the network client.
//
// CONTENT-FREE GUARANTEE: the check-in body carries ONLY the allowlisted keys
// below — never a URL, page content, clipboard, filename, detected value, or
// count. `buildCheckinRequest` is the single constructor and cannot emit any
// other key; a test asserts the emitted key set.

import type { components } from './generated/teams-contract'

/** Managed settings the server may push down. Only `show_indicator` in M1. */
export interface ManagedSettings {
  readonly show_indicator: boolean
}

// ── Enroll: POST {BASE}/functions/v1/enroll ──

export interface EnrollRequest {
  readonly code: string
  readonly label: string
}

export interface EnrollSuccess {
  readonly install_id: string
  /** The per-install credential — shown ONCE. Store it; never fetch it again. */
  readonly install_credential: string
  readonly org_id: string
  readonly org_name: string
}

/** Discriminated enroll errors, mapped from the contract's HTTP status codes. */
export type EnrollErrorCode =
  | 'invalid_code' // 404
  | 'already_used' // 409
  | 'expired' // 410
  | 'revoked' // 410
  | 'network' // offline / fetch threw / non-JSON / unexpected status
  | 'not_configured' // no backend base URL / anon key in this build
  | 'already_enrolled' // client-side: another install is already enrolled (never overwritten)

export interface EnrollFailure {
  readonly ok: false
  readonly code: EnrollErrorCode
}
export interface EnrollOk {
  readonly ok: true
  readonly data: EnrollSuccess
}
export type EnrollResult = EnrollOk | EnrollFailure

// ── Check-in: POST {BASE}/functions/v1/checkin (content-free) ──

/** Self-test evidence — ONLY ever from a REAL self-test, carrying THAT test's
 *  original timestamp. Never synthesized at check-in time. */
export interface SelfTestEvidence {
  readonly passed: boolean
  /** The original self-test timestamp (ISO-8601). Never rewritten at check-in. */
  readonly at: string
  /** Backend contract v1.4.0: recorded on THIS installation (its quick check). */
  readonly outcome?: 'pass' | 'fail' | 'incomplete'
  /** Ids of the checks that ran (e.g. `chatgpt-send`), ^[a-z0-9_.-]{1,64}$. */
  readonly scope?: readonly string[]
  readonly suite_version?: string
}

export interface CheckinRequest {
  readonly install_id: string
  readonly credential: string
  readonly extension_version?: string
  readonly self_test?: SelfTestEvidence
  readonly applied_settings_revision?: number
}

/** The ONLY keys a check-in body may contain. Guarded by a test. */
export const CHECKIN_ALLOWED_KEYS: readonly (keyof CheckinRequest)[] = [
  'install_id',
  'credential',
  'extension_version',
  'self_test',
  'applied_settings_revision',
]
export const SELF_TEST_ALLOWED_KEYS: readonly (keyof SelfTestEvidence)[] = [
  'passed',
  'at',
  'outcome',
  'scope',
  'suite_version',
]
const SELF_TEST_SCOPE_ID = /^[a-z0-9_.-]{1,64}$/

export interface CheckinActive {
  readonly revoked: false
  readonly org_id: string
  readonly target_settings_revision: number
  readonly settings: ManagedSettings
}
export interface CheckinRevoked {
  readonly revoked: true
}
export type CheckinResponse = CheckinActive | CheckinRevoked

/**
 * Build the check-in request body with ONLY allowed fields. Optional fields are
 * included only when present, so the emitted object never carries a stray key.
 * `self_test` is passed through AS-IS (its `at` is the real test's timestamp);
 * this builder never creates a timestamp.
 */
export function buildCheckinRequest(input: {
  install_id: string
  credential: string
  extension_version?: string
  self_test?: SelfTestEvidence
  applied_settings_revision?: number
}): CheckinRequest {
  const body: {
    install_id: string
    credential: string
    extension_version?: string
    self_test?: SelfTestEvidence
    applied_settings_revision?: number
  } = {
    install_id: input.install_id,
    credential: input.credential,
  }
  if (input.extension_version !== undefined) body.extension_version = input.extension_version
  if (input.self_test !== undefined) {
    // Re-project self_test through its own allowlist so no stray sub-key leaks.
    const st = input.self_test
    body.self_test = {
      passed: st.passed,
      at: st.at,
      ...(st.outcome === 'pass' || st.outcome === 'fail' || st.outcome === 'incomplete'
        ? { outcome: st.outcome }
        : {}),
      ...(Array.isArray(st.scope)
        ? {
            scope: st.scope
              .filter((x) => typeof x === 'string' && SELF_TEST_SCOPE_ID.test(x))
              .slice(0, 32),
          }
        : {}),
      ...(typeof st.suite_version === 'string'
        ? { suite_version: st.suite_version.slice(0, 40) }
        : {}),
    }
  }
  if (input.applied_settings_revision !== undefined) {
    body.applied_settings_revision = input.applied_settings_revision
  }
  return body
}

/** True when `x` is a well-formed check-in response (either active or revoked). */
export function isCheckinResponse(x: unknown): x is CheckinResponse {
  if (x === null || typeof x !== 'object') return false
  const r = x as Record<string, unknown>
  if (r.revoked === true) return true
  if (r.revoked !== false) return false
  if (typeof r.org_id !== 'string') return false
  if (typeof r.target_settings_revision !== 'number') return false
  const s = r.settings as Record<string, unknown> | undefined
  if (s === undefined || s === null || typeof s.show_indicator !== 'boolean') return false
  return true
}

/** True when `x` is a well-formed enroll success body. */
export function isEnrollSuccess(x: unknown): x is EnrollSuccess {
  if (x === null || typeof x !== 'object') return false
  const r = x as Record<string, unknown>
  return (
    typeof r.install_id === 'string' &&
    typeof r.install_credential === 'string' &&
    typeof r.org_id === 'string' &&
    typeof r.org_name === 'string'
  )
}

/** Map an enroll HTTP status to the contract's error code (non-2xx only). */
export function enrollErrorForStatus(status: number): EnrollErrorCode {
  if (status === 404) return 'invalid_code'
  if (status === 409) return 'already_used'
  if (status === 410) return 'expired' // expired | revoked share 410; treated the same
  return 'network'
}

// ─── /provision errors (Contract B §5) ───────────────────────────────
// 410 carries an explicit body `error`. Revocation is split so the extension
// never has to infer what was revoked:
//   • `token_revoked`   — the DEPLOYMENT TOKEN was revoked. No block: a rotated
//                         or new token may still enroll this browser.
//   • `install_revoked` — THIS INSTALLATION was revoked. Sets the persistent
//                         no-reenroll block (survives token rotation).
export const PROVISION_GONE_ERRORS = [
  'expired',
  'token_revoked',
  'install_revoked',
  'recovery_window_expired',
] as const
export type ProvisionGoneError = (typeof PROVISION_GONE_ERRORS)[number]
export type ProvisionErrorCode = 'invalid_token' | 'exhausted' | ProvisionGoneError | 'network'

/** Map a non-2xx /provision answer to its error code. An unrecognized 410 body
 *  is treated as `expired` (terminal, no block); anything unexpected is
 *  `network` (retry with the same attempt). */
export function provisionErrorFor(status: number, body: unknown): ProvisionErrorCode {
  if (status === 404) return 'invalid_token'
  if (status === 409) return 'exhausted'
  if (status === 410) {
    const err = (body as { error?: unknown } | null)?.error
    return (PROVISION_GONE_ERRORS as readonly unknown[]).includes(err)
      ? (err as ProvisionGoneError)
      : 'expired'
  }
  return 'network'
}

// ─── Canonical error enum (bridge/1.1.0, OpenAPI Error.error) ─────────
// The TYPE comes from the generated contract (contracts/teams-contract.openapi.yaml,
// x-contract-version 1.1.0 -> src/shared/generated/teams-contract.ts); the runtime
// list below is checked against it at compile time (both directions) and against
// the YAML in tests. `revoked` no longer exists: it is split into `token_revoked`
// (deployment token) and `install_revoked` (this install).
export type ApiErrorCode = components['schemas']['Error']['error']
export const API_ERROR_CODES = [
  'invalid_token',
  'invalid_proof',
  'exhausted',
  'expired',
  'token_revoked',
  'install_revoked',
  'recovery_window_expired',
  // v1.1.1: a valid session for another identity (/join-init, website only) and
  // the invitation-dead codes (never retry).
  'wrong_recipient',
  'invitation_revoked',
  'invitation_expired',
  'invitation_consumed',
] as const satisfies readonly ApiErrorCode[]
// Compile-time exhaustiveness: every generated enum member is in the runtime list.
type _AllCodesListed =
  Exclude<ApiErrorCode, (typeof API_ERROR_CODES)[number]> extends never ? true : never
export const _allCodesListed: _AllCodesListed = true

// /join (contract v1.1.1): 401 = invalid_proof; 410 =
//   expired                  — the exchange token lapsed: RECOVERABLE (same
//                              attempt, new token, within the window);
//   invitation_revoked |
//   invitation_expired |
//   invitation_consumed      — the invitation is dead: never retry;
//   install_revoked          — this install was revoked: blocks re-enrollment;
//   recovery_window_expired  — the completed join can no longer be recovered.
// Each is handled distinctly; none but install_revoked is an install revocation.
export const INVITATION_DEAD_ERRORS = [
  'invitation_revoked',
  'invitation_expired',
  'invitation_consumed',
] as const
export type InvitationDeadError = (typeof INVITATION_DEAD_ERRORS)[number]
export const JOIN_GONE_ERRORS = [
  'expired',
  'install_revoked',
  'recovery_window_expired',
  ...INVITATION_DEAD_ERRORS,
] as const
export type JoinGoneError = (typeof JOIN_GONE_ERRORS)[number]
export type JoinErrorCode = 'invalid_proof' | JoinGoneError | 'network'

/** Map a non-2xx /join answer to its error code. An unrecognized 410 body is
 *  `expired` (recoverable within the window, never a block, never a dead
 *  invitation); anything unexpected is `network`. */
export function joinErrorFor(status: number, body: unknown): JoinErrorCode {
  if (status === 401) return 'invalid_proof'
  if (status === 410) {
    const err = (body as { error?: unknown } | null)?.error
    return (JOIN_GONE_ERRORS as readonly unknown[]).includes(err)
      ? (err as JoinGoneError)
      : 'expired'
  }
  return 'network'
}

// ─── idempotency_key derivation (bridge/1.1.0 — PINNED, domain-separated) ──
// idempotency_key = base64url_nopad(SHA-256(UTF-8(<domain tag> + <attempt secret>)))
//   /provision: tag "alg-provision-idem:" + attempt_id
//   /join:      tag "alg-join-idem:"      + attempt_secret
// The tag keeps the key distinct from the S256 attempt_challenge
// (= SHA-256(attempt_secret) with no tag) and from the other endpoint's key.
// Deterministic, so a retry of the same attempt always carries the same key and
// the backend derives the identical value.
export const IDEMPOTENCY_DOMAIN_TAGS = {
  provision: 'alg-provision-idem:',
  join: 'alg-join-idem:',
} as const
export type IdempotencyEndpoint = keyof typeof IDEMPOTENCY_DOMAIN_TAGS

/** Derive the pinned idempotency key for an attempt on `endpoint`. */
export async function deriveIdempotencyKey(
  endpoint: IdempotencyEndpoint,
  attemptSecret: string,
): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(IDEMPOTENCY_DOMAIN_TAGS[endpoint] + attemptSecret),
    ),
  )
  let bin = ''
  for (const b of digest) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
