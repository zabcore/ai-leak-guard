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
export const SELF_TEST_ALLOWED_KEYS: readonly (keyof SelfTestEvidence)[] = ['passed', 'at']

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
    body.self_test = { passed: input.self_test.passed, at: input.self_test.at }
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
