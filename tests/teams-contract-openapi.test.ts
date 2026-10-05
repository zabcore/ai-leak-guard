// Teams Lite — the extension is pinned to the CANONICAL backend contract
// (zabcore/teams-onboarding-backend, teams-contract.openapi.yaml v1.1.0). These
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

const read = (p: string) => readFileSync(resolve(p), 'utf8')
const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const yaml = read('contracts/teams-contract.openapi.yaml')

describe('pinned teams-contract.openapi.yaml (v1.1.0)', () => {
  it('pinned YAML and generated types are unchanged (re-pin via contracts/README.md)', () => {
    expect(sha(yaml)).toBe('4adc678b1efa5d9d463a0f90ef9daff9235249d334922714e24713e144cf736a')
    expect(sha(read('src/shared/generated/teams-contract.ts'))).toBe(
      '5322a005283c33bfd6e0e3d28b8ab295e331b17b5e590443a39c6e20a6014230',
    )
    expect(yaml).toMatch(/x-contract-version: "1\.1\.0"/)
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
    expect(yaml).toContain('description: expired | install_revoked | recovery_window_expired')
    expect([...PROVISION_GONE_ERRORS].sort()).toEqual(
      ['expired', 'token_revoked', 'install_revoked', 'recovery_window_expired'].sort(),
    )
    expect([...JOIN_GONE_ERRORS].sort()).toEqual(
      ['expired', 'install_revoked', 'recovery_window_expired'].sort(),
    )
  })

  it('idempotency domain tags are the ones the contract documents', () => {
    expect(yaml).toContain(`base64url(SHA256('${IDEMPOTENCY_DOMAIN_TAGS.provision}' + attempt_id))`)
    expect(yaml).toContain(`base64url(SHA256('${IDEMPOTENCY_DOMAIN_TAGS.join}' + attempt_secret))`)
  })
})
