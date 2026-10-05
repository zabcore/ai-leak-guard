// Teams Lite (deployment m1) — provisioning orchestration (Contract B §5a).
// Executed tests for the client-side retry-safety: persist-before-request,
// same-attempt reuse on retry (worker-restart safety), terminal-outcome cleanup,
// and "token/install revoked never enrols".

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runProvision } from '../src/enterprise/teams-provision'
import { getEnrollment, setEnrollment } from '../src/shared/teams-storage'
import { getProvisionAttempt } from '../src/shared/teams-provision-attempt'
import { createHash } from 'node:crypto'
import type { ProvisionCallResult } from '../src/enterprise/teams-client'

const BASE = 'http://127.0.0.1:54321'
const OK: ProvisionCallResult = {
  ok: true,
  data: { install_id: 'i1', install_credential: 'c1', org_id: 'org_1', org_name: 'Harbor', },
}

/** A provision client that returns queued results and records each request. */
function mockClient(results: ProvisionCallResult[]) {
  const calls: Array<{ deployment_token: string; attempt_id: string; idempotency_key: string }> = []
  const loadClient = async () => ({
    provision: async (_b: string, _a: string, req: { deployment_token: string; attempt_id: string; idempotency_key: string }) => {
      calls.push(req)
      return results.shift() ?? ({ ok: false, code: 'network' } as ProvisionCallResult)
    },
  })
  return { loadClient, calls }
}

/** Deterministic id generator so attempt ids are assertable. */
function seqIds() {
  let n = 0
  return () => `id${++n}`
}

beforeEach(async () => {
  vi.stubEnv('VITE_TEAMS_BASE_URL', BASE)
  vi.stubEnv('VITE_TEAMS_ANON_KEY', 'anon')
  await chrome.storage.local.clear()
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('runProvision', () => {
  it('provisions and enrolls on success, then clears the attempt', async () => {
    const { loadClient, calls } = mockClient([OK])
    const outcome = await runProvision({ deploymentToken: 'tok-A', loadClient, newId: seqIds() })
    expect(outcome).toBe('enrolled')
    expect(calls[0]).toMatchObject({
      deployment_token: 'tok-A',
      attempt_id: 'id1',
      // Pinned: idempotency_key = base64url(SHA-256("alg-provision-idem:" + attempt_id)).
      idempotency_key: createHash('sha256').update('alg-provision-idem:id1').digest('base64url'),
    })
    expect(await getEnrollment()).toMatchObject({ install_id: 'i1', org_id: 'org_1', base_url: BASE })
    expect(await getProvisionAttempt()).toBeNull()
  })

  it('no-ops when already enrolled (no network)', async () => {
    await setEnrollment({ install_id: 'x', install_credential: 'y', org_id: 'org_1', org_name: 'H', base_url: BASE })
    const { loadClient, calls } = mockClient([OK])
    expect(await runProvision({ deploymentToken: 'tok-A', loadClient, newId: seqIds() })).toBe('already-enrolled')
    expect(calls).toHaveLength(0)
  })

  it('persists the attempt before the request and REUSES it on retry (worker-restart safety)', async () => {
    // First attempt: network failure — attempt must be kept.
    const first = mockClient([{ ok: false, code: 'network' }])
    const ids = seqIds()
    expect(await runProvision({ deploymentToken: 'tok-A', loadClient: first.loadClient, newId: ids })).toBe('network')
    const persisted = await getProvisionAttempt()
    expect(persisted).toMatchObject({ attemptId: 'id1', deploymentToken: 'tok-A' })

    // Retry (fresh id generator, as a restart would have): must REUSE id1, not mint a new one.
    const second = mockClient([OK])
    expect(await runProvision({ deploymentToken: 'tok-A', loadClient: second.loadClient, newId: seqIds() })).toBe('enrolled')
    expect(second.calls[0]?.attempt_id).toBe('id1')
    expect(first.calls[0]?.attempt_id).toBe(second.calls[0]?.attempt_id)
    expect(await getProvisionAttempt()).toBeNull()
  })

  it('keeps the attempt on network error (recoverable), clears it on terminal outcomes', async () => {
    const net = mockClient([{ ok: false, code: 'network' }])
    expect(await runProvision({ deploymentToken: 'tok-A', loadClient: net.loadClient, newId: seqIds() })).toBe('network')
    expect(await getProvisionAttempt()).not.toBeNull()

    const exhausted = mockClient([{ ok: false, code: 'exhausted' }])
    expect(await runProvision({ deploymentToken: 'tok-A', loadClient: exhausted.loadClient, newId: seqIds() })).toBe('exhausted')
    expect(await getProvisionAttempt()).toBeNull()
  })

  it.each([
    ['install_revoked', 'install-revoked'],
    ['token_revoked', 'token-revoked'],
  ] as const)('%s never enrolls and clears the attempt', async (code, outcome) => {
    const { loadClient } = mockClient([{ ok: false, code }])
    expect(await runProvision({ deploymentToken: 'tok-A', loadClient, newId: seqIds() })).toBe(outcome)
    expect(await getEnrollment()).toBeNull()
    expect(await getProvisionAttempt()).toBeNull()
  })

  it('maps recovery_window_expired, and does not reuse an attempt bound to a DIFFERENT token', async () => {
    // Strand an attempt for a different token, then provision tok-B.
    const stranded = mockClient([{ ok: false, code: 'network' }])
    expect(await runProvision({ deploymentToken: 'tok-OLD', loadClient: stranded.loadClient, newId: seqIds() })).toBe('network')

    const bNew = mockClient([{ ok: false, code: 'recovery_window_expired' }])
    expect(await runProvision({ deploymentToken: 'tok-B', loadClient: bNew.loadClient, newId: seqIds() })).toBe('recovery-expired')
    // Fresh attempt for tok-B (id1 from its own generator), NOT the tok-OLD attempt.
    expect(bNew.calls[0]?.deployment_token).toBe('tok-B')
    expect(bNew.calls[0]?.attempt_id).toBe('id1')
  })
})
