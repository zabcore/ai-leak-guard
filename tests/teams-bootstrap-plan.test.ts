// Teams Lite (deployment m1) — managed-policy bootstrap decision core.
// Encodes the Phase-3 safeguards: enrolled-wins (no silent clinic transfer),
// revoke-block survives token rotation / Activate, network-silence when no
// policy, and admin opt-out.

import { describe, it, expect } from 'vitest'
import {
  BOOTSTRAP_RECHECK_DELAY_MIN,
  BOOTSTRAP_RECHECK_MAX,
  planBootstrapRecheck,
  planManagedBootstrap,
} from '../src/background/teams-bootstrap-plan'

const policy = (deploymentToken?: string, autoEnroll?: boolean) => ({ deploymentToken, autoEnroll })

describe('planManagedBootstrap', () => {
  it('provisions when unenrolled, not blocked, and a token is present', () => {
    expect(
      planManagedBootstrap({ enrolled: false, revokedBlock: false, policy: policy('tok-A') }),
    ).toEqual({ action: 'provision', deploymentToken: 'tok-A' })
  })

  it('treats a missing autoEnroll as enabled', () => {
    expect(
      planManagedBootstrap({
        enrolled: false,
        revokedBlock: false,
        policy: { deploymentToken: 'tok-A' },
      }),
    ).toEqual({ action: 'provision', deploymentToken: 'tok-A' })
  })

  it('skips when already enrolled, even if the policy carries a DIFFERENT token (no silent clinic transfer)', () => {
    expect(
      planManagedBootstrap({ enrolled: true, revokedBlock: false, policy: policy('tok-NEW') }),
    ).toEqual({ action: 'skip', reason: 'already-enrolled' })
  })

  it('skips on revoke-block even with a valid token (revocation holds)', () => {
    expect(
      planManagedBootstrap({ enrolled: false, revokedBlock: true, policy: policy('tok-A') }),
    ).toEqual({ action: 'skip', reason: 'revoked-block' })
  })

  it('revoke-block survives token ROTATION — a new/rotated token must not reenroll a removed browser', () => {
    // Same blocked install, policy now carries a rotated token: still blocked.
    expect(
      planManagedBootstrap({ enrolled: false, revokedBlock: true, policy: policy('tok-ROTATED') }),
    ).toEqual({ action: 'skip', reason: 'revoked-block' })
  })

  it('skips (network-silent) when there is no policy or no token', () => {
    expect(planManagedBootstrap({ enrolled: false, revokedBlock: false, policy: null })).toEqual({
      action: 'skip',
      reason: 'no-policy',
    })
    expect(
      planManagedBootstrap({ enrolled: false, revokedBlock: false, policy: policy(undefined) }),
    ).toEqual({ action: 'skip', reason: 'no-policy' })
    expect(
      planManagedBootstrap({ enrolled: false, revokedBlock: false, policy: policy('') }),
    ).toEqual({ action: 'skip', reason: 'no-policy' })
  })

  it('skips on admin opt-out (autoEnroll:false) even with a token', () => {
    expect(
      planManagedBootstrap({
        enrolled: false,
        revokedBlock: false,
        policy: policy('tok-A', false),
      }),
    ).toEqual({ action: 'skip', reason: 'autoenroll-off' })
  })

  it('enrolled takes precedence over a revoke block (already managed → nothing to do)', () => {
    expect(
      planManagedBootstrap({ enrolled: true, revokedBlock: true, policy: policy('tok-A') }),
    ).toEqual({ action: 'skip', reason: 'already-enrolled' })
  })
})

describe('planBootstrapRecheck (F-TD-1 install re-check)', () => {
  it('schedules only after a no-policy skip, bounded by BOOTSTRAP_RECHECK_MAX', () => {
    expect(planBootstrapRecheck('no-policy', 0)).toEqual({
      schedule: true,
      delayMin: BOOTSTRAP_RECHECK_DELAY_MIN,
      nextCount: 1,
    })
    expect(planBootstrapRecheck('no-policy', BOOTSTRAP_RECHECK_MAX - 1)).toMatchObject({
      schedule: true,
      nextCount: BOOTSTRAP_RECHECK_MAX,
    })
    expect(planBootstrapRecheck('no-policy', BOOTSTRAP_RECHECK_MAX)).toEqual({ schedule: false })
  })

  it.each(['already-enrolled', 'revoked-block', 'autoenroll-off', null] as const)(
    'never re-checks after %s (enrolled, decided, or a provision result with its own retry)',
    (reason) => {
      expect(planBootstrapRecheck(reason, 0)).toEqual({ schedule: false })
    },
  )

  it('treats a corrupt stored count as 0', () => {
    expect(planBootstrapRecheck('no-policy', Number.NaN)).toMatchObject({
      schedule: true,
      nextCount: 1,
    })
    expect(planBootstrapRecheck('no-policy', -4)).toMatchObject({ schedule: true, nextCount: 1 })
  })
})
