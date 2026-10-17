// Teams Lite (deployment m1) — managed-policy bootstrap orchestration
// (Contract B §5 / §5b). Executed against injected policy + provision client;
// no live backend.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_BOOTSTRAP_RERUNS, runManagedBootstrap } from '../src/enterprise/teams-bootstrap'
import { TEAMS_BOOTSTRAP_DIAG_KEY, getLastBootstrapAttempt } from '../src/shared/teams-diag'
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
import type { ManagedBootstrapDeps } from '../src/enterprise/teams-bootstrap'

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

  it('`install_revoked` sets the block, and it then survives token rotation', async () => {
    const c = provisionClient([{ ok: false, code: 'install_revoked' }])
    expect(
      await runManagedBootstrap({
        readPolicy: policy({ deploymentToken: 'tok-A' }),
        loadClient: c.loadClient,
        newId: seqIds(),
      }),
    ).toEqual({ action: 'provision', outcome: 'install-revoked' })
    expect(await getRevokeBlock()).toBe(true)

    const rotated = provisionClient([OK])
    expect(
      await runManagedBootstrap({
        readPolicy: policy({ deploymentToken: 'tok-ROTATED' }),
        loadClient: rotated.loadClient,
      }),
    ).toEqual({ action: 'skip', reason: 'revoked-block' })
    expect(rotated.calls).toHaveLength(0)
  })

  it('`install_revoked` on a RETRY of an already-sent attempt blocks too (no inference needed)', async () => {
    const deps = { readPolicy: policy({ deploymentToken: 'tok-A' }), newId: seqIds() }
    await runManagedBootstrap({
      ...deps,
      loadClient: provisionClient([{ ok: false, code: 'network' }]).loadClient,
    })
    const retry = provisionClient([{ ok: false, code: 'install_revoked' }])
    expect(await runManagedBootstrap({ ...deps, loadClient: retry.loadClient })).toEqual({
      action: 'provision',
      outcome: 'install-revoked',
    })
    expect(retry.calls[0]?.attempt_id).toBe('id1')
    expect(await getRevokeBlock()).toBe(true)
  })

  it('`token_revoked` never sets the block — even on a retried attempt — so a rotated token can enroll', async () => {
    const deps = { readPolicy: policy({ deploymentToken: 'tok-REVOKED' }), newId: seqIds() }
    await runManagedBootstrap({
      ...deps,
      loadClient: provisionClient([{ ok: false, code: 'network' }]).loadClient,
    })
    const retry = provisionClient([{ ok: false, code: 'token_revoked' }])
    expect(await runManagedBootstrap({ ...deps, loadClient: retry.loadClient })).toEqual({
      action: 'provision',
      outcome: 'token-revoked',
    })
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

// ─── F-TD-1: a trigger arriving mid-run is coalesced, not swallowed ─────

/** A policy reader whose FIRST read lets the test act "during" the read (e.g. a
 *  second trigger joining the run after the policy read started), then returns
 *  the scripted policies in order. */
function scriptedPolicy(
  reads: Array<ManagedDeploymentPolicy | null>,
  duringFirstRead?: () => void,
) {
  let n = 0
  return {
    readPolicy: async (): Promise<ManagedDeploymentPolicy | null> => {
      const i = n++
      if (i === 0) duringFirstRead?.()
      return reads[Math.min(i, reads.length - 1)] ?? null
    },
    count: () => n,
  }
}

describe('runManagedBootstrap — coalesced reruns (F-TD-1)', () => {
  it('force-install race: install reads no policy, the policy-change joins mid-run → one more pass enrolls', async () => {
    const c = provisionClient([OK])
    let joined: Promise<unknown> | undefined
    const deps: ManagedBootstrapDeps = { loadClient: c.loadClient, newId: seqIds() }
    const p = scriptedPolicy([null, { deploymentToken: 'tok-A', autoEnroll: true }], () => {
      joined = runManagedBootstrap({ ...deps, readPolicy: p.readPolicy, trigger: 'policy-change' })
    })
    const first = await runManagedBootstrap({
      ...deps,
      readPolicy: p.readPolicy,
      trigger: 'install',
    })

    expect(first).toEqual({ action: 'provision', outcome: 'enrolled' })
    expect(await joined).toEqual(first) // the joined caller gets the FINAL result
    expect(p.count()).toBe(2)
    expect(c.calls).toHaveLength(1)
    expect(await getEnrollment()).toMatchObject({ install_id: 'i1' })
    const diag = (await chrome.storage.local.get(TEAMS_BOOTSTRAP_DIAG_KEY))[
      TEAMS_BOOTSTRAP_DIAG_KEY
    ]
    expect(diag).toEqual([
      expect.objectContaining({
        trigger: 'install',
        action: 'skip',
        result: 'no-policy',
        tokenPresent: false,
      }),
      expect.objectContaining({
        trigger: 'policy-change',
        action: 'provision',
        result: 'enrolled',
        tokenPresent: true,
      }),
    ])
  })

  it('a trigger that joins BEFORE the policy read needs no rerun (one read, one pass)', async () => {
    const c = provisionClient([OK])
    const p = scriptedPolicy([{ deploymentToken: 'tok-A' }])
    const deps = { readPolicy: p.readPolicy, loadClient: c.loadClient, newId: seqIds() }
    const [a, b] = await Promise.all([
      runManagedBootstrap({ ...deps, trigger: 'install' }),
      runManagedBootstrap({ ...deps, trigger: 'startup' }),
    ])
    expect(a).toEqual({ action: 'provision', outcome: 'enrolled' })
    expect(b).toEqual(a)
    expect(p.count()).toBe(1)
    expect(c.calls).toHaveLength(1)
  })

  it('reruns are bounded: at most 1 + MAX_BOOTSTRAP_RERUNS passes per run', async () => {
    let reads = 0
    const readPolicy = async (): Promise<ManagedDeploymentPolicy | null> => {
      reads++
      void runManagedBootstrap({ readPolicy, trigger: 'policy-change' }) // a trigger every pass
      return null
    }
    expect(await runManagedBootstrap({ readPolicy, trigger: 'install' })).toEqual({
      action: 'skip',
      reason: 'no-policy',
    })
    expect(reads).toBe(1 + MAX_BOOTSTRAP_RERUNS)
  })

  it('never reruns after enrolling (the caller must see `enrolled` to run the first check-in)', async () => {
    const c = provisionClient([OK])
    const p = scriptedPolicy([{ deploymentToken: 'tok-A' }])
    let joined: Promise<unknown> | undefined
    const loadClient = async () => {
      // A trigger lands while /provision is in flight (after the policy read).
      joined = runManagedBootstrap({ readPolicy: p.readPolicy, trigger: 'policy-change' })
      return c.loadClient()
    }
    const r = await runManagedBootstrap({
      readPolicy: p.readPolicy,
      loadClient,
      newId: seqIds(),
      trigger: 'install',
    })
    expect(r).toEqual({ action: 'provision', outcome: 'enrolled' })
    expect(await joined).toEqual(r)
    expect(p.count()).toBe(1)
  })

  it('never reruns a revoke block (permanent by design — no rerun, no request)', async () => {
    const { setRevokeBlock } = await import('../src/shared/teams-storage')
    await setRevokeBlock()
    const c = provisionClient([OK])
    const p = scriptedPolicy([{ deploymentToken: 'tok-A' }], () => {
      void runManagedBootstrap({
        readPolicy: p.readPolicy,
        loadClient: c.loadClient,
        trigger: 'policy-change',
      })
    })
    expect(
      await runManagedBootstrap({
        readPolicy: p.readPolicy,
        loadClient: c.loadClient,
        trigger: 'startup',
      }),
    ).toEqual({
      action: 'skip',
      reason: 'revoked-block',
    })
    expect(p.count()).toBe(1)
    expect(c.calls).toHaveLength(0)
    expect(await getLastBootstrapAttempt()).toMatchObject({
      result: 'revoked-block',
      tokenPresent: true,
    })
  })
})

// ─── Same-attempt retry, including the FINAL slot ──────────────────────
//
// A fake /provision with ONE free slot, modelling the server's contract: a NEW
// attempt consumes a slot; the SAME attempt recovers its credential without
// consuming another; a different attempt once the slot is gone is `exhausted`.
// The first response is LOST after the server consumed the slot. Every retry
// path the client has — a coalesced rerun, the provision-retry alarm, a browser
// restart — must send the SAME attempt_id, so the final slot is recovered rather
// than reported exhausted.
function oneSlotServer() {
  const issued = new Map<string, ProvisionCallResult>()
  let slotsLeft = 1
  let loseNextResponse = true
  const seen: string[] = []
  const loadClient = async () => ({
    provision: async (
      _b: string,
      _a: string,
      req: ProvisionRequest,
    ): Promise<ProvisionCallResult> => {
      seen.push(req.attempt_id)
      let result = issued.get(req.attempt_id)
      if (result === undefined) {
        if (slotsLeft === 0) return { ok: false, code: 'exhausted' }
        slotsLeft--
        result = OK
        issued.set(req.attempt_id, result)
      }
      if (loseNextResponse) {
        loseNextResponse = false
        return { ok: false, code: 'network' } // slot consumed, response lost
      }
      return result
    },
  })
  return { loadClient, seen, slotsLeft: () => slotsLeft }
}

describe('same-attempt retry, including the final slot (Contract B §5a)', () => {
  it('lost response on the final slot → a mid-run trigger, then the retry alarm, recover it with the SAME attempt', async () => {
    const server = oneSlotServer()
    const policyA = policy({ deploymentToken: 'tok-A' })
    let joined: Promise<unknown> | undefined
    const deps: ManagedBootstrapDeps = { loadClient: server.loadClient, newId: seqIds() }
    const readPolicy = async () => {
      joined ??= runManagedBootstrap({ ...deps, readPolicy: policyA, trigger: 'policy-change' })
      return policyA()
    }
    expect(await runManagedBootstrap({ ...deps, readPolicy, trigger: 'install' })).toEqual({
      action: 'provision',
      outcome: 'network',
    })
    expect(await joined).toEqual({ action: 'provision', outcome: 'network' }) // no rerun after network
    expect(server.seen).toEqual(['id1'])

    // The provision-retry alarm (or a restart) — same persisted attempt.
    expect(
      await runManagedBootstrap({ ...deps, readPolicy: policyA, trigger: 'provision-retry' }),
    ).toEqual({
      action: 'provision',
      outcome: 'enrolled',
    })
    expect(server.seen).toEqual(['id1', 'id1'])
    expect(server.slotsLeft()).toBe(0)
    expect(await getEnrollment()).toMatchObject({ install_id: 'i1' })
    expect(await getProvisionAttempt()).toBeNull()
  })

  it('the install re-check path (no policy, then policy) also reuses the persisted attempt after a lost response', async () => {
    const server = oneSlotServer()
    const deps: ManagedBootstrapDeps = { loadClient: server.loadClient, newId: seqIds() }
    expect(
      await runManagedBootstrap({ ...deps, readPolicy: policy(null), trigger: 'install' }),
    ).toEqual({
      action: 'skip',
      reason: 'no-policy',
    })
    expect(
      await runManagedBootstrap({
        ...deps,
        readPolicy: policy({ deploymentToken: 'tok-A' }),
        trigger: 'recheck',
      }),
    ).toEqual({ action: 'provision', outcome: 'network' })
    expect(
      await runManagedBootstrap({
        ...deps,
        readPolicy: policy({ deploymentToken: 'tok-A' }),
        trigger: 'recheck',
      }),
    ).toEqual({ action: 'provision', outcome: 'enrolled' })
    expect(new Set(server.seen)).toEqual(new Set(['id1']))
    expect(server.slotsLeft()).toBe(0)
  })
})

describe('bootstrap diagnostics are content-free', () => {
  it('records the decision and token presence — never the token or the attempt secret', async () => {
    const c = provisionClient([{ ok: false, code: 'exhausted' }])
    await runManagedBootstrap({
      readPolicy: policy({ deploymentToken: 'tok-SECRET-VALUE' }),
      loadClient: c.loadClient,
      newId: () => 'attempt-SECRET-VALUE',
      trigger: 'startup',
    })
    const raw = JSON.stringify(
      (await chrome.storage.local.get(TEAMS_BOOTSTRAP_DIAG_KEY))[TEAMS_BOOTSTRAP_DIAG_KEY],
    )
    expect(raw).not.toContain('SECRET')
    expect(await getLastBootstrapAttempt()).toMatchObject({
      trigger: 'startup',
      action: 'provision',
      result: 'exhausted',
      tokenPresent: true,
    })
  })
})
