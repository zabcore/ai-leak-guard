// Teams Lite — the extension is pinned to the CANONICAL backend contract
// (zabcore/teams-onboarding-backend, teams-contract.openapi.yaml v1.3.0). These
// checks fail if the pinned YAML or the generated types change without a re-pin,
// or if the extension's runtime values drift from the contract.

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  API_ERROR_CODES,
  IDEMPOTENCY_DOMAIN_TAGS,
  JOIN_GONE_ERRORS,
  PROVISION_GONE_ERRORS,
} from '../src/shared/teams-contract'

// Line endings normalized: .gitattributes forces LF, and this keeps a CRLF working
// copy from a misconfigured Windows checkout from failing the pins spuriously.
const read = (p: string) => readFileSync(resolve(p), 'utf8').replace(/\r\n/g, '\n')
const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const yaml = read('contracts/teams-contract.openapi.yaml')

describe('pinned teams-contract.openapi.yaml (v1.3.0)', () => {
  it('pinned YAML and generated types are unchanged (re-pin via contracts/README.md)', () => {
    expect(sha(yaml)).toBe('6d3992fbc5528bedca722ff8ba065ddf08eb7da96c134adfd6f954dfb45ad0d3')
    expect(sha(read('src/shared/generated/teams-contract.ts'))).toBe(
      'ec47cf5c320cedf709ffbf8d6f3993e0225f7ca1589688e4bb7236704121f73c',
    )
    expect(yaml).toMatch(/x-contract-version: "1\.3\.0"/)
  })

  it('runtime error list equals the YAML Error.error enum', () => {
    const m = /enum: \[(invalid_token[^\]]*)\]/.exec(yaml)
    expect(m).not.toBeNull()
    expect([...API_ERROR_CODES]).toEqual(m![1].split(',').map((s) => s.trim()))
  })

  it('every /provision and /join 410 error is a contract code, matching the documented 410s', () => {
    for (const code of [...PROVISION_GONE_ERRORS, ...JOIN_GONE_ERRORS]) {
      expect(API_ERROR_CODES as readonly string[]).toContain(code)
    }
    expect(yaml).toContain(
      'description: expired | token_revoked | install_revoked | recovery_window_expired',
    )
    expect(yaml).toContain(
      'description: expired (exchange token lapsed; recoverable) | invitation_revoked | invitation_expired | invitation_consumed | install_revoked | recovery_window_expired',
    )
    expect([...PROVISION_GONE_ERRORS].sort()).toEqual(
      ['expired', 'token_revoked', 'install_revoked', 'recovery_window_expired'].sort(),
    )
    expect([...JOIN_GONE_ERRORS].sort()).toEqual(
      [
        'expired',
        'install_revoked',
        'recovery_window_expired',
        'invitation_revoked',
        'invitation_expired',
        'invitation_consumed',
      ].sort(),
    )
  })

  it('idempotency domain tags are the ones the contract documents', () => {
    expect(yaml).toContain(`base64url(SHA256('${IDEMPOTENCY_DOMAIN_TAGS.provision}' + attempt_id))`)
    expect(yaml).toContain(`base64url(SHA256('${IDEMPOTENCY_DOMAIN_TAGS.join}' + attempt_secret))`)
  })
})
