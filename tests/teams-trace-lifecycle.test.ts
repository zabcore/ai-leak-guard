// Track D close-out (1.3.8) — the trace at the enrollment lifecycle's real
// boundaries, and the read-only export.
//  • provision-start is DURABLE before /provision is called (a started attempt
//    that never completes is still on record);
//  • a retry after a lost response is traced as the SAME (reused) attempt;
//  • a revoke's receipt and its cleanup are two events with their own times;
//  • the export surfaces the acceptance fields and never a secret.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runManagedBootstrap } from '../src/enterprise/teams-bootstrap'
import { runCheckin } from '../src/enterprise/teams-service'
import type { ProvisionCallResult, ProvisionRequest } from '../src/enterprise/teams-client'
import { readTraceStore, traceIntegrity, type TraceEvent } from '../src/shared/teams-trace'
import { buildTeamsExport, readTeamsExport, TEAMS_EXPORT_KEYS } from '../src/shared/teams-export'
import { setEnrollment, setManagedState, setPreManagedPrefs } from '../src/shared/teams-storage'
import { setPrefs } from '../src/shared/storage'

const BASE = 'http://127.0.0.1:54321'
const OK: ProvisionCallResult = {
  ok: true,
  data: {
    install_id: 'i-B',
    install_credential: 'CRED-SECRET',
    org_id: 'org_1',
    org_name: 'Harbor',
  },
}
const policy = (deploymentToken: string) => async () => ({ deploymentToken, autoEnroll: true })
const seqIds = () => {
  let n = 0
  return () => `ATTEMPT-SECRET-${++n}`
}
const events = async (): Promise<TraceEvent[]> => [...((await readTraceStore())?.events ?? [])]
const ofType = async (type: string) => (await events()).filter((e) => e.type === type)

beforeEach(() => {
  vi.stubEnv('VITE_TEAMS_BASE_URL', BASE)
  vi.stubEnv('VITE_TEAMS_ANON_KEY', 'anon')
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('provision-start is recorded before the request', () => {
  it('is already persisted when /provision is called', async () => {
    let seenAtCall: TraceEvent[] = []
    const loadClient = async () => ({
      provision: async (_b: string, _a: string, _r: ProvisionRequest) => {
        seenAtCall = await events() // what storage holds at the moment of the request
        return OK
      },
    })
    await runManagedBootstrap({
      readPolicy: policy('TOKEN-SECRET'),
      loadClient,
      newId: seqIds(),
      trigger: 'install',
    })
    expect(seenAtCall.map((e) => e.type)).toEqual([
      'trace-init',
      'bootstrap-decision',
      'provision-start',
    ])
    expect(seenAtCall.at(-1)).toMatchObject({ trigger: 'install', attempt: 'new' })
    expect((await ofType('provision-result'))[0]).toMatchObject({
      outcome: 'enrolled',
      install_id: 'i-B',
    })
  })

  it('a started attempt that NEVER completes (blocked / hung request) is still on record', async () => {
    let release: (v: ProvisionCallResult) => void = () => {}
    const loadClient = async () => ({
      provision: () => new Promise<ProvisionCallResult>((r) => (release = r)),
    })
    const run = runManagedBootstrap({
      readPolicy: policy('TOKEN-SECRET'),
      loadClient,
      newId: seqIds(),
      trigger: 'startup',
    })
    await vi.waitFor(async () => expect(await ofType('provision-start')).toHaveLength(1))
    // The worker could die right here: the record exists, no result yet.
    expect(await ofType('provision-result')).toHaveLength(0)
    expect(traceIntegrity(await readTraceStore()).state).toBe('intact')
    release({ ok: false, code: 'network' })
    await run
  })

  it('a retry after a lost response is traced as the SAME attempt, reused', async () => {
    const results: ProvisionCallResult[] = [{ ok: false, code: 'network' }, OK]
    const loadClient = async () => ({ provision: async () => results.shift() ?? OK })
    const deps = { readPolicy: policy('TOKEN-SECRET'), loadClient, newId: seqIds() }
    await runManagedBootstrap({ ...deps, trigger: 'install' })
    await runManagedBootstrap({ ...deps, trigger: 'provision-retry' })
    const starts = await ofType('provision-start')
    expect(starts.map((e) => [e.trigger, e.attempt])).toEqual([
      ['install', 'new'],
      ['provision-retry', 'reused'],
    ])
    expect(starts[1]?.attemptRef).toBe(starts[0]?.attemptRef)
    expect((await ofType('provision-result')).map((e) => e.outcome)).toEqual([
      'network',
      'enrolled',
    ])
  })
})

describe('revoke: receipt and cleanup are separate, ordered events', () => {
  it('check-in revoke → revoke-response-received (receipt instant), then cleanup-completed', async () => {
    await setEnrollment({
      install_id: 'i-B',
      install_credential: 'CRED-SECRET',
      org_id: 'org_1',
      org_name: 'Harbor',
      base_url: BASE,
    })
    let respondedAt = 0
    const outcome = await runCheckin({
      reason: 'startup',
      loadClient: async () => ({
        enroll: vi.fn(),
        checkin: async () => {
          respondedAt = performance.timeOrigin + performance.now()
          return { ok: true, response: { revoked: true } } as never
        },
      }),
    })
    expect(outcome).toBe('revoke')
    const [received] = await ofType('revoke-response-received')
    const [cleanup] = await ofType('cleanup-completed')
    expect(received).toMatchObject({
      source: 'checkin',
      trigger: 'startup',
      install_id: 'i-B',
      org_id: 'org_1',
    })
    expect(cleanup).toMatchObject({
      source: 'checkin',
      install_id: 'i-B',
      enrollmentCleared: true,
      revokedNotice: true,
      revokeBlock: true,
    })
    expect(received!.seq).toBeLessThan(cleanup!.seq)
    // receipt is stamped at the response, not when it was logged; cleanup later
    expect(received!.atHr).toBeGreaterThanOrEqual(respondedAt)
    expect(cleanup!.atHr).toBeGreaterThan(received!.atHr)
    expect(cleanup!.atHr).not.toBe(received!.atHr)
  })

  it('provision install_revoked → receipt, then cleanup after the revoke block is set', async () => {
    const loadClient = async () => ({
      provision: async () => ({ ok: false, code: 'install_revoked' }) as ProvisionCallResult,
    })
    await runManagedBootstrap({
      readPolicy: policy('TOKEN-SECRET'),
      loadClient,
      newId: seqIds(),
      trigger: 'startup',
    })
    const types = (await events()).map((e) => e.type)
    expect(types.indexOf('revoke-response-received')).toBeLessThan(
      types.indexOf('cleanup-completed'),
    )
    expect((await ofType('cleanup-completed'))[0]).toMatchObject({
      source: 'provision',
      revokeBlock: true,
    })
  })
})

describe('read-only export', () => {
  const SECRETS = ['CRED-SECRET', 'TOKEN-SECRET', 'ATTEMPT-SECRET']

  it('surfaces identity, revoke flags, managed state, saved + current showIndicator — and no secret', async () => {
    await setEnrollment({
      install_id: 'i-B',
      install_credential: 'CRED-SECRET',
      org_id: 'org_1',
      org_name: 'Harbor',
      base_url: BASE,
    })
    await setManagedState({ appliedSettingsRevision: 2, orgId: 'org_1' })
    await setPreManagedPrefs({ showIndicator: false })
    await setPrefs({ showIndicator: true })
    await chrome.storage.local.set({
      teamsProvisionAttempt: {
        attemptId: 'ATTEMPT-SECRET-9',
        deploymentToken: 'TOKEN-SECRET',
        idempotencyKey: 'IDEM',
        createdAt: 'x',
      },
    })
    ;(chrome.storage.managed as unknown as { __set: (v: unknown) => void }).__set({
      deploymentToken: 'TOKEN-SECRET',
      autoEnroll: true,
    })
    const x = await readTeamsExport()

    expect(x.identity).toEqual({
      enrolled: true,
      install_id: 'i-B',
      org_id: 'org_1',
      org_name: 'Harbor',
    })
    expect(x.revoke).toEqual({ revokeBlock: false, revokedNotice: false })
    expect(x.managedState).toEqual({ present: true, appliedSettingsRevision: 2, orgId: 'org_1' })
    expect(x.showIndicator).toEqual({
      current: true,
      currentIsDefault: false,
      saved: false,
      savedRecordPresent: true,
    })
    expect(x.policy).toEqual({ present: true, tokenPresent: true, autoEnroll: true })
    expect(x.provisioning.attemptPending).toBe(true)
    expect(x.provisioning.attemptRef).toMatch(/^[0-9a-f]{12}$/)
    const json = JSON.stringify(x)
    for (const s of SECRETS) expect(json).not.toContain(s)
    expect(json).not.toContain('IDEM')
    ;(chrome.storage.managed as unknown as { __set: (v: unknown) => void }).__set(null)
  })

  it('is read-only: storage is byte-identical before and after, and nothing is fetched', async () => {
    await setEnrollment({
      install_id: 'i-B',
      install_credential: 'CRED-SECRET',
      org_id: 'org_1',
      org_name: 'Harbor',
      base_url: BASE,
    })
    const fetchSpy = vi.fn()
    ;(globalThis as { fetch?: unknown }).fetch = fetchSpy
    const before = JSON.stringify(await chrome.storage.local.get(null))
    await readTeamsExport()
    expect(JSON.stringify(await chrome.storage.local.get(null))).toBe(before)
    expect(fetchSpy).not.toHaveBeenCalled()
    delete (globalThis as { fetch?: unknown }).fetch
  })

  it('an empty export says WHY it is empty: no trace store vs. a complete one', () => {
    const empty = buildTeamsExport({
      exportedAt: 't',
      extensionId: 'id',
      version: '1.3.8',
      local: {},
      managedPolicy: null,
      pendingAttemptRef: null,
    })
    expect(empty.trace.integrity.state).toBe('absent')
    expect(empty.trace.events).toEqual([])
    expect(empty.identity.enrolled).toBe(false)
    expect(empty.showIndicator).toEqual({
      current: true,
      currentIsDefault: true,
      saved: null,
      savedRecordPresent: false,
    })
  })

  it('reads only the allow-listed keys', () => {
    expect(TEAMS_EXPORT_KEYS).not.toContain('counters')
    expect([...TEAMS_EXPORT_KEYS].every((k) => k === 'prefs' || k.startsWith('teams'))).toBe(true)
  })
})
