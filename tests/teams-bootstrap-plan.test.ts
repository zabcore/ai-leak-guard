// Teams Lite (deployment m1) — managed-policy bootstrap decision core.
// Encodes the Phase-3 safeguards: enrolled-wins (no silent clinic transfer),
// revoke-block survives token rotation / Activate, network-silence when no
// policy, and admin opt-out.

import { describe, it, expect } from 'vitest'
import { planManagedBootstrap } from '../src/background/teams-bootstrap-plan'

const policy = (deploymentToken?: string, autoEnroll?: boolean) => ({ deploymentToken, autoEnroll })

describe('planManagedBootstrap', () => {
  it('provisions when unenrolled, not blocked, and a token is present', () => {
    expect(planManagedBootstrap({ enrolled: false, revokedBlock: false, policy: policy('tok-A') }))
      .toEqual({ action: 'provision', deploymentToken: 'tok-A' })
  })

  it('treats a missing autoEnroll as enabled', () => {
    expect(
      planManagedBootstrap({ enrolled: false, revokedBlock: false, policy: { deploymentToken: 'tok-A' } }),
    ).toEqual({ action: 'provision', deploymentToken: 'tok-A' })
  })

  it('skips when already enrolled, even if the policy carries a DIFFERENT token (no silent clinic transfer)', () => {
    expect(planManagedBootstrap({ enrolled: true, revokedBlock: false, policy: policy('tok-NEW') }))
      .toEqual({ action: 'skip', reason: 'already-enrolled' })
  })

  it('skips on revoke-block even with a valid token (revocation holds)', () => {
    expect(planManagedBootstrap({ enrolled: false, revokedBlock: true, policy: policy('tok-A') }))
      .toEqual({ action: 'skip', reason: 'revoked-block' })
  })

  it('revoke-block survives token ROTATION — a new/rotated token must not reenroll a removed browser', () => {
    // Same blocked install, policy now carries a rotated token: still blocked.
    expect(planManagedBootstrap({ enrolled: false, revokedBlock: true, policy: policy('tok-ROTATED') }))
      .toEqual({ action: 'skip', reason: 'revoked-block' })
  })

  it('skips (network-silent) when there is no policy or no token', () => {
    expect(planManagedBootstrap({ enrolled: false, revokedBlock: false, policy: null }))
      .toEqual({ action: 'skip', reason: 'no-policy' })
    expect(planManagedBootstrap({ enrolled: false, revokedBlock: false, policy: policy(undefined) }))
      .toEqual({ action: 'skip', reason: 'no-policy' })
    expect(planManagedBootstrap({ enrolled: false, revokedBlock: false, policy: policy('') }))
      .toEqual({ action: 'skip', reason: 'no-policy' })
  })

  it('skips on admin opt-out (autoEnroll:false) even with a token', () => {
    expect(planManagedBootstrap({ enrolled: false, revokedBlock: false, policy: policy('tok-A', false) }))
      .toEqual({ action: 'skip', reason: 'autoenroll-off' })
  })

  it('enrolled takes precedence over a revoke block (already managed → nothing to do)', () => {
    expect(planManagedBootstrap({ enrolled: true, revokedBlock: true, policy: policy('tok-A') }))
      .toEqual({ action: 'skip', reason: 'already-enrolled' })
  })
})
