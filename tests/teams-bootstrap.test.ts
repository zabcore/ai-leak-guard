// Teams Lite (deployment m1) — managed-policy bootstrap orchestration
// (Contract B §5 / §5b). Executed against injected policy + provision client;
// no live backend.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runManagedBootstrap } from '../src/enterprise/teams-bootstrap'
import { runCheckin, runEnroll, runUnenroll } from '../src/enterprise/teams-service'
import type { ManagedDeploymentPolicy } from '../src/background/teams-bootstrap-plan'
import type { ProvisionCallResult, ProvisionRequest } from '../src/enterprise/teams-client'
import {
  clearRevokeBlock,
  getEnrollment,
  getRevokeBlock,
  setEnrollment,
} from '../src/shared/teams-storage'
import { getProvisionAttempt } from '../src/shared/teams-provision-attempt'

const BASE = 'http://127.0.0.1:54321'
const OK: ProvisionCallResult = {
  ok: true,
  data: { install_id: 'i1', install_credential: 'c1', org_id: 'org_1', org_name: 'Harbor' },
}

function provisionClient(results: ProvisionCallResult[] = []) {
  const calls: ProvisionRequest[] = []
  const loadClient = async () => ({
    provision: async (_b: string, _a: string, req: ProvisionRequest) => {
      calls.push(req)
      return results.shift() ?? OK
    },
  })
  return { loadClient, calls }
}

const policy =
  (p: ManagedDeploymentPolicy | null) => async (): Promise<ManagedDeploymentPolicy | null> =>
    p

function seqIds() {
  let n = 0
  return () => `id${++n}`
}

const ENROLLMENT = {
  install_id: 'inst_1',
  install_credential: 'cred_1',
  org_id: 'org_1',
  org_name: 'Harbor',
  base_url: BASE,
}

beforeEach(() => {
  vi.stubEnv('VITE_TEAMS_BASE_URL', BASE)
  vi.stubEnv('VITE_TEAMS_ANON_KEY', 'anon')
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  delete (globalThis as { fetch?: unknown }).fetch
})

describe('runManagedBootstrap — provision only when the decision is provision', () => {
  it('provisions with the policy token when unenrolled + unblocked', async () => {
    const c = provisionClient([OK])
    const r = await runManagedBootstrap({
      readPolicy: policy({ deploymentToken: 'tok-A' }),
      loadClient: c.loadClient,
      newId: seqIds(),
    })
    expect(r).toEqual({ action: 'provision', outcome: 'enrolled' })
    expect(c.calls).toHaveLength(1)
    expect(c.calls[0]?.deployment_token).toBe('tok-A')
    expect(await getEnrollment()).toMatchObject({ install_id: 'i1', org_id: 'org_1' })
  })

  it.each([
    ['no policy', null, 'no-policy'],
    ['policy without a token', { autoEnroll: true }, 'no-policy'],
    ['autoEnroll:false', { deploymentToken: 'tok-A', autoEnroll: false }, 'autoenroll-off'],
  ] as const)('skips without calling the client: %s', async (_name, p, reason) => {
    const c = provisionClient()
    const r = await runManagedBootstrap({ readPolicy: policy(p), loadClient: c.loadClient })
    expect(r).toEqual({ action: 'skip', reason })
    expect(c.calls).toHaveLength(0)
  })

  it('already enrolled + a CHANGED token → skip (never silently transfers clinics)', async () => {
    await setEnrollment(ENROLLMENT)
    const c = provisionClient()
    const r = await runManagedBootstrap({
      readPolicy: policy({ deploymentToken: 'tok-OTHER-CLINIC' }),
      loadClient: c.loadClient,
    })
    expect(r).toEqual({ action: 'skip', reason: 'already-enrolled' })
    expect(c.calls).toHaveLength(0)
    expect(await getEnrollment()).toEqual(ENROLLMENT)
  })

  it('serializes concurrent triggers: startup + install + policy-change mint ONE attempt', async () => {
    const c = provisionClient([{ ok: false, code: 'network' }])
    const deps = {
      readPolicy: policy({ deploymentToken: 'tok-A' }),
      loadClient: c.loadClient,
      newId: seqIds(),
    }
    const results = await Promise.all([
      runManagedBootstrap(deps),
      runManagedBootstrap(deps),
      runManagedBootstrap(deps),
    ])
    expect(results.every((r) => r.action === 'provision' && r.outcome === 'network')).toBe(true)
    expect(c.calls).toHaveLength(1)
    expect(await getProvisionAttempt()).toMatchObject({ attemptId: 'id1' })
  })
})

describe('revoke block (Contract B §5b — no auto-reenroll)', () => {
  async function revokeViaCheckin(): Promise<void> {
    await setEnrollment(ENROLLMENT)
    const outcome = await runCheckin({
      loadClient: async () => ({
        enroll: vi.fn(),
        checkin: async () => ({ ok: true, response: { revoked: true } }) as never,
      }),
    })
    expect(outcome).toBe('revoke')
  }

  it('a confirmed check-in revoke persists the block', async () => {
    await revokeViaCheckin()
    expect(await getEnrollment()).toBeNull()
    expect(await getRevokeBlock()).toBe(true)
  })

  it('blocks provisioning across token ROTATION', async () => {
    await revokeViaCheckin()
    for (const token of ['tok-A', 'tok-ROTATED', 'tok-ROTATED-AGAIN']) {
      const c = provisionClient()
      const r = await runManagedBootstrap({
        readPolicy: policy({ deploymentToken: token }),
        loadClient: c.loadClient,
      })
      expect(r).toEqual({ action: 'skip', reason: 'revoked-block' })
      expect(c.calls).toHaveLength(0)
    }
  })

  it('survives clicking Activate (code enroll) and a later unenroll', async () => {
    await revokeViaCheckin()
    const enrolled = await runEnroll('CODE', 'Front desk', {
      loadClient: async () => ({
        enroll: async () => ({
          ok: true as const,
          data: { install_id: 'i2', install_credential: 'c2', org_id: 'org_1', org_name: 'Harbor' },
        }),
        checkin: vi.fn(),
      }),
    })
    expect(enrolled.ok).toBe(true)
    expect(await getRevokeBlock()).toBe(true)
    await runUnenroll()
    expect(await getRevokeBlock()).toBe(true)

    const c = provisionClient()
    const r = await runManagedBootstrap({
      readPolicy: policy({ deploymentToken: 'tok-ROTATED' }),
      loadClient: c.loadClient,
    })
    expect(r).toEqual({ action: 'skip', reason: 'revoked-block' })
    expect(c.calls).toHaveLength(0)
  })

  it('clears ONLY via the explicit authorized-recovery call', async () => {
    await revokeViaCheckin()
    await clearRevokeBlock()
    const c = provisionClient([OK])
    const r = await runManagedBootstrap({
      readPolicy: policy({ deploymentToken: 'tok-ROTATED' }),
      loadClient: c.loadClient,
      newId: seqIds(),
    })
    expect(r).toEqual({ action: 'provision', outcome: 'enrolled' })
  })

  it('`revoked` while RECOVERING an already-sent attempt sets the block (install removed)', async () => {
    const deps = { readPolicy: policy({ deploymentToken: 'tok-A' }), newId: seqIds() }
    await runManagedBootstrap({
      ...deps,
      loadClient: provisionClient([{ ok: false, code: 'network' }]).loadClient,
    })
    const retry = provisionClient([{ ok: false, code: 'revoked' }])
    const r = await runManagedBootstrap({ ...deps, loadClient: retry.loadClient })
    expect(r).toEqual({ action: 'provision', outcome: 'revoked' })
    expect(retry.calls[0]?.attempt_id).toBe('id1') // same attempt was retried
    expect(await getRevokeBlock()).toBe(true)
  })

  it('`revoked` on a FRESH attempt is the token itself → no block, a rotated token can enroll', async () => {
    const first = provisionClient([{ ok: false, code: 'revoked' }])
    expect(
      await runManagedBootstrap({
        readPolicy: policy({ deploymentToken: 'tok-REVOKED' }),
        loadClient: first.loadClient,
        newId: seqIds(),
      }),
    ).toEqual({ action: 'provision', outcome: 'revoked' })
    expect(await getRevokeBlock()).toBe(false)

    const rotated = provisionClient([OK])
    expect(
      await runManagedBootstrap({
        readPolicy: policy({ deploymentToken: 'tok-NEW' }),
        loadClient: rotated.loadClient,
        newId: seqIds(),
      }),
    ).toEqual({ action: 'provision', outcome: 'enrolled' })
  })
})

describe('network silence', () => {
  it('no policy → NO network call, even through the DEFAULT (real) client loader', async () => {
    const fetchSpy = vi.fn()
    ;(globalThis as { fetch: unknown }).fetch = fetchSpy
    const r = await runManagedBootstrap() // default policy reader + default loader
    expect(r).toEqual({ action: 'skip', reason: 'no-policy' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
