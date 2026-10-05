// Teams Lite (#78) — wire contract: content-free check-in payload + guards.

import { describe, expect, it } from 'vitest'
import {
  buildCheckinRequest,
  isCheckinResponse,
  isEnrollSuccess,
  enrollErrorForStatus,
  provisionErrorFor,
  deriveIdempotencyKey,
  IDEMPOTENCY_DOMAIN_TAGS,
  API_ERROR_CODES,
  joinErrorFor,
  CHECKIN_ALLOWED_KEYS,
} from '../src/shared/teams-contract'

describe('buildCheckinRequest — content-free', () => {
  it('emits ONLY the allowed keys (no URLs, content, filenames, counts)', () => {
    const req = buildCheckinRequest({
      install_id: 'inst_1',
      credential: 'cred_1',
      extension_version: '1.3.6',
      self_test: { passed: true, at: '2026-09-28T10:00:00.000Z' },
      applied_settings_revision: 3,
    })
    const keys = Object.keys(req).sort()
    // Every emitted key is in the allowlist.
    for (const k of keys) expect(CHECKIN_ALLOWED_KEYS).toContain(k)
    expect(keys).toEqual(
      [
        'applied_settings_revision',
        'credential',
        'extension_version',
        'install_id',
        'self_test',
      ].sort(),
    )
    // self_test carries only passed + at.
    expect(Object.keys(req.self_test ?? {}).sort()).toEqual(['at', 'passed'])
  })

  it('omits optional fields entirely when absent (no stray keys)', () => {
    const req = buildCheckinRequest({ install_id: 'i', credential: 'c' })
    expect(Object.keys(req)).toEqual(['install_id', 'credential'])
    expect('self_test' in req).toBe(false)
    expect('extension_version' in req).toBe(false)
    expect('applied_settings_revision' in req).toBe(false)
  })

  it('a stray field passed alongside a valid self_test is NOT forwarded', () => {
    const req = buildCheckinRequest({
      install_id: 'i',
      credential: 'c',
      // @ts-expect-error — a hostile/accidental extra sub-key must be dropped.
      self_test: { passed: false, at: '2026-01-01T00:00:00.000Z', filename: 'secret.pdf' },
    })
    expect(Object.keys(req.self_test ?? {}).sort()).toEqual(['at', 'passed'])
    expect(JSON.stringify(req)).not.toContain('secret.pdf')
  })

  it('preserves the self-test ORIGINAL timestamp verbatim (never rewritten)', () => {
    const original = '2026-09-28T09:41:12.345Z'
    const req = buildCheckinRequest({
      install_id: 'i',
      credential: 'c',
      self_test: { passed: true, at: original },
    })
    expect(req.self_test?.at).toBe(original)
  })
})

describe('isCheckinResponse', () => {
  it('accepts a well-formed active response', () => {
    expect(
      isCheckinResponse({
        revoked: false,
        org_id: 'org_1',
        target_settings_revision: 2,
        settings: { show_indicator: true },
      }),
    ).toBe(true)
  })
  it('accepts a revoked response', () => {
    expect(isCheckinResponse({ revoked: true })).toBe(true)
  })
  it('rejects malformed bodies', () => {
    expect(isCheckinResponse(null)).toBe(false)
    expect(isCheckinResponse({})).toBe(false)
    expect(isCheckinResponse({ revoked: false, org_id: 'o' })).toBe(false) // missing revision/settings
    expect(isCheckinResponse({ revoked: false, org_id: 'o', target_settings_revision: 1 })).toBe(
      false,
    )
    expect(
      isCheckinResponse({
        revoked: false,
        org_id: 'o',
        target_settings_revision: 1,
        settings: {},
      }),
    ).toBe(false)
  })
})

describe('isEnrollSuccess / enrollErrorForStatus', () => {
  it('validates an enroll success body', () => {
    expect(
      isEnrollSuccess({ install_id: 'i', install_credential: 'c', org_id: 'o', org_name: 'n' }),
    ).toBe(true)
    expect(isEnrollSuccess({ install_id: 'i' })).toBe(false)
  })
  it('maps HTTP status codes to error codes', () => {
    expect(enrollErrorForStatus(404)).toBe('invalid_code')
    expect(enrollErrorForStatus(409)).toBe('already_used')
    expect(enrollErrorForStatus(410)).toBe('expired')
    expect(enrollErrorForStatus(500)).toBe('network')
  })
})

describe('provisionErrorFor (Contract B §5 — explicit revoke split)', () => {
  it('maps status + body to the pinned error enum', () => {
    expect(provisionErrorFor(404, null)).toBe('invalid_token')
    expect(provisionErrorFor(409, null)).toBe('exhausted')
    expect(provisionErrorFor(410, { error: 'expired' })).toBe('expired')
    expect(provisionErrorFor(410, { error: 'token_revoked' })).toBe('token_revoked')
    expect(provisionErrorFor(410, { error: 'install_revoked' })).toBe('install_revoked')
    expect(provisionErrorFor(410, { error: 'recovery_window_expired' })).toBe(
      'recovery_window_expired',
    )
    expect(provisionErrorFor(500, null)).toBe('network')
  })

  it('an ambiguous / unknown 410 (incl. a bare legacy "revoked") is terminal `expired` — never a block', () => {
    expect(provisionErrorFor(410, { error: 'revoked' })).toBe('expired')
    expect(provisionErrorFor(410, null)).toBe('expired')
  })
})

describe('deriveIdempotencyKey (bridge/1.1.0: domain-separated)', () => {
  it('is base64url(SHA-256(tag + secret)), deterministic, per-endpoint tag', async () => {
    const { createHash } = await import('node:crypto')
    const id = '6f1c2a0e-1b7d-4e55-9a3f-0c2d4b8e9f10'
    const p = await deriveIdempotencyKey('provision', id)
    expect(p).toBe(createHash('sha256').update(`alg-provision-idem:${id}`).digest('base64url'))
    expect(await deriveIdempotencyKey('provision', id)).toBe(p)
    expect(await deriveIdempotencyKey('join', id)).toBe(
      createHash('sha256').update(`alg-join-idem:${id}`).digest('base64url'),
    )
    expect(p).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it('never equals the untagged S256 challenge, nor the other endpoint key', async () => {
    const { createHash } = await import('node:crypto')
    const secret = 'verifier-secret-1'
    const challenge = createHash('sha256').update(secret).digest('base64url')
    const join = await deriveIdempotencyKey('join', secret)
    expect(join).not.toBe(challenge)
    expect(join).not.toBe(await deriveIdempotencyKey('provision', secret))
  })

  it('shared test vectors — the backend must derive the same values for "abc"', async () => {
    expect(IDEMPOTENCY_DOMAIN_TAGS).toEqual({
      provision: 'alg-provision-idem:',
      join: 'alg-join-idem:',
    })
    expect(await deriveIdempotencyKey('provision', 'abc')).toBe(
      '3Ih5gPY5claPtZn3TrQSYK_TOWgz9e7F2bWN6kSr4Sc',
    )
    expect(await deriveIdempotencyKey('join', 'abc')).toBe(
      'wr9yGO-HiZXg5IzUjNEDFiwwcz4jZ7JWPpqs3nYdROc',
    )
  })
})

describe('canonical error enum + joinErrorFor (bridge/1.1.0)', () => {
  it('Error.error enum has no bare "revoked"', () => {
    expect([...API_ERROR_CODES]).toEqual([
      'invalid_token',
      'invalid_proof',
      'exhausted',
      'expired',
      'token_revoked',
      'install_revoked',
      'recovery_window_expired',
    ])
  })

  it('/join: 401 invalid_proof; 410 expired | install_revoked | recovery_window_expired', () => {
    expect(joinErrorFor(401, null)).toBe('invalid_proof')
    expect(joinErrorFor(410, { error: 'expired' })).toBe('expired')
    expect(joinErrorFor(410, { error: 'install_revoked' })).toBe('install_revoked')
    expect(joinErrorFor(410, { error: 'recovery_window_expired' })).toBe('recovery_window_expired')
    expect(joinErrorFor(410, { error: 'token_revoked' })).toBe('expired') // not a /join error
    expect(joinErrorFor(410, { error: 'revoked' })).toBe('expired')
    expect(joinErrorFor(500, null)).toBe('network')
  })
})
