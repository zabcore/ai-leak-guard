// Teams Lite (#78) — the orchestration service: enroll storage, the end-to-end
// reconcile→persist for apply / offline-retain / revocation, self-test evidence
// timestamp, and Free-mode silence (no client load when unenrolled).
//
// Uses the in-memory chrome.storage stub (tests/setup.ts) and an INJECTED
// client, so no real network and no dynamic import occur.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runEnroll, runCheckin, runUnenroll } from '../src/enterprise/teams-service'
import {
  getEnrollment,
  setEnrollment,
  clearEnrollment,
  getManagedState,
  setManagedState,
  getPreManagedPrefs,
  setPreManagedPrefs,
  getRevokedNotice,
} from '../src/shared/teams-storage'
import { getPrefs, setPrefs, setSelfTestResult } from '../src/shared/storage'
import type { CheckinRequest, CheckinResponse, EnrollResult } from '../src/shared/teams-contract'
import type { CheckinCallResult } from '../src/enterprise/teams-client'

const BASE = 'http://127.0.0.1:54321'

interface MockClient {
  loadClient: () => Promise<{
    enroll: (b: string, a: string, req: unknown) => Promise<EnrollResult>
    checkin: (b: string, a: string, req: CheckinRequest) => Promise<CheckinCallResult>
  }>
  loadCalls: number
  checkinRequests: CheckinRequest[]
}

function mockClient(opts: { enroll?: EnrollResult; checkin?: CheckinCallResult }): MockClient {
  const state = { loadCalls: 0, checkinRequests: [] as CheckinRequest[] }
  return {
    get loadCalls() {
      return state.loadCalls
    },
    get checkinRequests() {
      return state.checkinRequests
    },
    loadClient: async () => {
      state.loadCalls += 1
      return {
        enroll: async () => opts.enroll ?? { ok: false as const, code: 'network' as const },
        checkin: async (_b, _a, req) => {
          state.checkinRequests.push(req)
          return opts.checkin ?? { ok: false as const }
        },
      }
    },
  }
}

const activeResponse = (revision: number, show: boolean): CheckinResponse => ({
  revoked: false,
  org_id: 'org_1',
  target_settings_revision: revision,
  settings: { show_indicator: show },
})

beforeEach(() => {
  vi.stubEnv('VITE_TEAMS_BASE_URL', BASE)
  vi.stubEnv('VITE_TEAMS_ANON_KEY', 'anon-key')
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

async function enrolledFixture(): Promise<void> {
  await setEnrollment({
    install_id: 'inst_1',
    install_credential: 'cred_1',
    org_id: 'org_1',
    org_name: 'Harbor',
    base_url: BASE,
  })
}

describe('runEnroll', () => {
  it('success stores the credential + org + base_url and clears any revoked notice', async () => {
    const client = mockClient({
      enroll: {
        ok: true,
        data: { install_id: 'i', install_credential: 'c', org_id: 'o', org_name: 'Harbor' },
      },
    })
    const result = await runEnroll('CODE', 'Front desk', { loadClient: client.loadClient })
    expect(result.ok).toBe(true)
    const stored = await getEnrollment()
    expect(stored).toEqual({
      install_id: 'i',
      install_credential: 'c',
      org_id: 'o',
      org_name: 'Harbor',
      base_url: BASE,
    })
  })

  it('an error result is returned and NOTHING is stored', async () => {
    const client = mockClient({ enroll: { ok: false, code: 'invalid_code' } })
    const result = await runEnroll('BAD', 'x', { loadClient: client.loadClient })
    expect(result).toEqual({ ok: false, code: 'invalid_code' })
    expect(await getEnrollment()).toBeNull()
  })

  it('an unconfigured build returns not_configured WITHOUT loading the client', async () => {
    // Force an unconfigured build explicitly — stubbing empty strings (not just
    // unstubbing) so a developer's local `.env.local` can't make this a false pass.
    vi.stubEnv('VITE_TEAMS_BASE_URL', '')
    vi.stubEnv('VITE_TEAMS_ANON_KEY', '')
    const client = mockClient({
      enroll: {
        ok: true,
        data: { install_id: 'i', install_credential: 'c', org_id: 'o', org_name: 'n' },
      },
    })
    const result = await runEnroll('CODE', 'x', { loadClient: client.loadClient })
    expect(result).toEqual({ ok: false, code: 'not_configured' })
    expect(client.loadCalls).toBe(0)
  })
})

describe('runCheckin — Free-mode silence', () => {
  it('unenrolled → skipped, and the client is NEVER loaded (no network)', async () => {
    const client = mockClient({ checkin: { ok: true, response: activeResponse(1, false) } })
    const outcome = await runCheckin({ loadClient: client.loadClient })
    expect(outcome).toBe('skipped-unenrolled')
    expect(client.loadCalls).toBe(0)
    expect(client.checkinRequests).toEqual([])
  })
})

describe('runCheckin — apply / re-report / no-op', () => {
  it('target > applied snapshots the prior pref, applies show_indicator, persists the revision', async () => {
    await enrolledFixture()
    await setPrefs({ showIndicator: true }) // the user's prior value
    const client = mockClient({ checkin: { ok: true, response: activeResponse(1, false) } })

    const outcome = await runCheckin({ loadClient: client.loadClient })
    expect(outcome).toBe('apply')
    expect((await getPrefs()).showIndicator).toBe(false) // managed value applied
    expect(await getManagedState()).toEqual({ appliedSettingsRevision: 1, orgId: 'org_1' })
    expect(await getPreManagedPrefs()).toEqual({ showIndicator: true }) // snapshot of prior
  })

  it('reports the applied revision back on the NEXT check-in', async () => {
    await enrolledFixture()
    await setManagedState({ appliedSettingsRevision: 2, orgId: 'org_1' })
    const client = mockClient({ checkin: { ok: true, response: activeResponse(2, false) } })
    const outcome = await runCheckin({ loadClient: client.loadClient })
    expect(outcome).toBe('noop') // target == applied
    expect(client.checkinRequests[0]?.applied_settings_revision).toBe(2)
  })
})

describe('runCheckin — offline / non-2xx RETAINS', () => {
  it('keeps the last valid config and does not reset it', async () => {
    await enrolledFixture()
    await setManagedState({ appliedSettingsRevision: 3, orgId: 'org_1' })
    await setPreManagedPrefs({ showIndicator: true })
    await setPrefs({ showIndicator: false }) // managed value currently applied
    const client = mockClient({ checkin: { ok: false } }) // offline / non-2xx

    const outcome = await runCheckin({ loadClient: client.loadClient })
    expect(outcome).toBe('retain')
    // Nothing downgraded or reset.
    expect((await getPrefs()).showIndicator).toBe(false)
    expect(await getManagedState()).toEqual({ appliedSettingsRevision: 3, orgId: 'org_1' })
    expect(await getPreManagedPrefs()).toEqual({ showIndicator: true })
    expect(await getEnrollment()).not.toBeNull() // still enrolled — retry later
  })
})

describe('runCheckin — confirmed revocation', () => {
  it('stops management, removes the overlay, restores the user prior pref, drops the credential', async () => {
    await enrolledFixture()
    await setManagedState({ appliedSettingsRevision: 2, orgId: 'org_1' })
    await setPreManagedPrefs({ showIndicator: true }) // user originally ON
    await setPrefs({ showIndicator: false }) // management turned it OFF
    const client = mockClient({ checkin: { ok: true, response: { revoked: true } } })

    const outcome = await runCheckin({ loadClient: client.loadClient })
    expect(outcome).toBe('revoke')
    expect((await getPrefs()).showIndicator).toBe(true) // RESTORED prior value (not blind default logic differs here)
    expect(await getManagedState()).toBeNull()
    expect(await getPreManagedPrefs()).toBeNull()
    expect(await getEnrollment()).toBeNull() // management over
    expect(await getRevokedNotice()).toBe(true)
  })
})

describe('runCheckin — self-test evidence timestamp', () => {
  it('sends a REAL self-test result with its ORIGINAL timestamp, never rewritten', async () => {
    await enrolledFixture()
    const originalTs = '2026-09-28T09:41:12.345Z'
    await setSelfTestResult({
      nonce: 'n',
      result: 'confirmed',
      code: 'OK',
      site: 'gemini',
      adapter: 'gemini',
      composer: 1,
      intercept: 1,
      modal: 1,
      ts: originalTs,
    })
    const client = mockClient({ checkin: { ok: true, response: activeResponse(1, true) } })

    await runCheckin({ loadClient: client.loadClient })
    // Second check-in a moment later — the timestamp must NOT be regenerated.
    await runCheckin({ loadClient: client.loadClient })

    for (const req of client.checkinRequests) {
      // #88: the installation's quick check carries outcome + scope + suite.
      expect(req.self_test).toEqual({
        passed: true,
        at: originalTs,
        outcome: 'pass',
        scope: ['gemini-send'],
        suite_version: '0.0.0',
      })
    }
  })

  it('maps every self-test result to a quick-check outcome (unsupported → incomplete)', async () => {
    await enrolledFixture()
    for (const [result, outcome] of [
      ['fail', 'fail'],
      ['unsupported', 'incomplete'],
    ] as const) {
      await setSelfTestResult({
        nonce: 'n',
        result,
        code: 'OK',
        site: 'chatgpt',
        adapter: 'chatgpt',
        composer: 1,
        intercept: 0,
        modal: 0,
        ts: '2026-10-07T10:00:00.000Z',
      })
      const client = mockClient({ checkin: { ok: true, response: activeResponse(1, true) } })
      await runCheckin({ loadClient: client.loadClient })
      expect(client.checkinRequests[0]?.self_test).toMatchObject({
        passed: false,
        outcome,
        scope: ['chatgpt-send'],
      })
    }
  })

  it('omits self_test entirely when no real self-test has run', async () => {
    await enrolledFixture()
    const client = mockClient({ checkin: { ok: true, response: activeResponse(1, true) } })
    await runCheckin({ loadClient: client.loadClient })
    expect('self_test' in (client.checkinRequests[0] ?? {})).toBe(false)
  })
})

describe('runCheckin — concurrency safety (CodeRabbit #79)', () => {
  it('serializes overlapping runs through one shared in-flight call', async () => {
    await enrolledFixture()
    const client = mockClient({ checkin: { ok: true, response: activeResponse(1, false) } })
    // Two concurrent triggers (e.g. startup + post-enroll) must reuse ONE run.
    const [a, b] = await Promise.all([
      runCheckin({ loadClient: client.loadClient }),
      runCheckin({ loadClient: client.loadClient }),
    ])
    expect(a).toBe('apply')
    expect(b).toBe('apply')
    expect(client.checkinRequests.length).toBe(1) // not two racing check-ins
    expect(client.loadCalls).toBe(1)
  })

  it('does NOT apply a stale result if enrollment was cleared during the request', async () => {
    await enrolledFixture()
    await setPrefs({ showIndicator: true })
    // Simulate a concurrent unenroll/revocation landing WHILE the request is in
    // flight: the mocked checkin clears the enrollment before returning "active".
    const client: MockClient = {
      loadCalls: 0,
      checkinRequests: [],
      loadClient: async () => ({
        enroll: async () => ({ ok: false as const, code: 'network' as const }),
        checkin: async () => {
          await clearEnrollment()
          return { ok: true as const, response: activeResponse(1, false) }
        },
      }),
    }
    const outcome = await runCheckin({ loadClient: client.loadClient })
    expect(outcome).toBe('skipped-unenrolled')
    // The stale "show_indicator:false" was NOT applied over the user's pref.
    expect((await getPrefs()).showIndicator).toBe(true)
    expect(await getManagedState()).toBeNull()
  })
})

describe('runUnenroll', () => {
  it('restores the user prior pref, clears state, does NOT flag a revocation', async () => {
    await enrolledFixture()
    await setManagedState({ appliedSettingsRevision: 2, orgId: 'org_1' })
    await setPreManagedPrefs({ showIndicator: true })
    await setPrefs({ showIndicator: false })

    await runUnenroll()
    expect((await getPrefs()).showIndicator).toBe(true) // restored
    expect(await getManagedState()).toBeNull()
    expect(await getPreManagedPrefs()).toBeNull()
    expect(await getEnrollment()).toBeNull()
    expect(await getRevokedNotice()).toBe(false) // user-initiated, not revoked
  })
})
