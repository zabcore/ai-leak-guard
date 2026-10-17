// Teams Lite — INVARIANT 4: enrollment conflicts are enforced at the STORAGE
// layer. A freshly issued credential (join, managed provision, code-entry
// enroll) never silently overwrites an existing enrollment — not for a
// different invitation, not for competing join tabs, not for a racing flow.
// The website's result binding guards the display; this guards the store.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { commitEnrollment, getEnrollment, setEnrollment } from '../src/shared/teams-storage'
import { exchangeJoin, prepareChallenge } from '../src/enterprise/teams-join'
import { runProvision } from '../src/enterprise/teams-provision'
import { runEnroll } from '../src/enterprise/teams-service'
import { getJoinAttempt } from '../src/shared/teams-join-attempt'
import { createJoinPortServer, uuidv7, type JoinPort } from '../src/background/teams-join-port'

const BASE = 'http://127.0.0.1:54321'
const EXISTING = {
  install_id: 'install-EXISTING',
  install_credential: 'cred-EXISTING',
  org_id: 'org-A',
  org_name: 'Clinic A',
  base_url: BASE,
}
const fresh = (id: string, org = 'org-B') => ({
  install_id: id,
  install_credential: `cred-${id}`,
  org_id: org,
  org_name: `Clinic ${org}`,
})

beforeEach(() => {
  vi.stubEnv('VITE_TEAMS_BASE_URL', BASE)
  vi.stubEnv('VITE_TEAMS_ANON_KEY', 'anon')
})
afterEach(() => vi.unstubAllEnvs())

describe('commitEnrollment (the store)', () => {
  it('refuses a different install and leaves the existing enrollment untouched', async () => {
    await setEnrollment(EXISTING)
    expect(await commitEnrollment({ ...fresh('install-NEW'), base_url: BASE })).toEqual({
      ok: false,
      reason: 'already_enrolled',
    })
    expect(await getEnrollment()).toEqual(EXISTING)
  })

  it('allows re-storing the SAME install (a recovered / replayed credential)', async () => {
    await setEnrollment(EXISTING)
    expect(await commitEnrollment({ ...EXISTING, org_name: 'Clinic A (renamed)' })).toEqual({
      ok: true,
    })
    expect((await getEnrollment())?.install_id).toBe('install-EXISTING')
  })

  it('two concurrent commits of different installs: exactly one is stored', async () => {
    const [a, b] = await Promise.all([
      commitEnrollment({ ...fresh('install-1', 'org-1'), base_url: BASE }),
      commitEnrollment({ ...fresh('install-2', 'org-2'), base_url: BASE }),
    ])
    expect([a.ok, b.ok].sort()).toEqual([false, true])
    const stored = await getEnrollment()
    expect(stored?.install_id).toBe(a.ok ? 'install-1' : 'install-2')
  })
})

describe('every credential producer goes through the store guard', () => {
  it('join: an enrollment that lands DURING /join is never overwritten', async () => {
    const nonce = uuidv7()
    await prepareChallenge('inv-B', nonce, { newSecret: () => 's'.repeat(43) })
    const loadClient = async () => ({
      join: async () => {
        await setEnrollment(EXISTING) // e.g. a code-entry enroll finished meanwhile
        return { ok: true as const, data: { ...fresh('install-JOIN'), role: 'staff' as const } }
      },
    })
    const out = await exchangeJoin('xt-1', nonce, { loadClient })
    expect(out).toEqual({
      result: { status: 'failed', error_code: 'already_enrolled' },
      enrolledNow: false,
    })
    expect(await getEnrollment()).toEqual(EXISTING)
    expect(await getJoinAttempt()).toBeNull()
  })

  it('managed provision: never switches clinics at the store', async () => {
    const loadClient = async () => ({
      provision: async () => {
        await setEnrollment(EXISTING)
        return { ok: true as const, data: fresh('install-PROV') }
      },
    })
    expect(await runProvision({ deploymentToken: 'tok', loadClient })).toBe('already-enrolled')
    expect(await getEnrollment()).toEqual(EXISTING)
  })

  it('code-entry enroll: refused with already_enrolled, existing kept', async () => {
    const loadClient = async () => ({
      enroll: async () => {
        await setEnrollment(EXISTING)
        return { ok: true as const, data: fresh('install-CODE') }
      },
      checkin: async () => ({ ok: false as const, code: 'network' as const }),
    })
    expect(await runEnroll('CODE', 'Front desk', { loadClient } as never)).toEqual({
      ok: false,
      code: 'already_enrolled',
    })
    expect(await getEnrollment()).toEqual(EXISTING)
  })
})

describe('competing join tabs', () => {
  function tab(id: number) {
    const posted: Array<{ type: string; nonce: string; payload: Record<string, unknown> }> = []
    let onMsg: (m: unknown) => void = () => {}
    const port: JoinPort = {
      name: 'zc.join.v1',
      sender: { origin: 'https://zabcore.com', url: 'https://zabcore.com/join', tab: { id } },
      postMessage: (m) => posted.push(m as (typeof posted)[number]),
      disconnect: () => {},
      onMessage: { addListener: (f) => (onMsg = f) },
      onDisconnect: { addListener: () => {} },
    }
    const env = (type: string, payload: Record<string, unknown>) => ({
      ns: 'zc.join',
      v: 1,
      type,
      nonce: uuidv7(),
      ts: new Date().toISOString(),
      payload,
    })
    return {
      port,
      posted,
      hello: (ref: string) => onMsg(env('hello', { invitation_ref: ref, locale: 'en' })),
      exchange: (token: string, challengeNonce: string) =>
        onMsg(
          env('exchange_token', {
            exchange_token: token,
            expires_at: 'x',
            challenge_nonce: challengeNonce,
          }),
        ),
      last: () => posted[posted.length - 1],
    }
  }

  it('a second invitation in another tab can never redeem over, or overwrite, the first', async () => {
    const calls: string[] = []
    const loadClient = async () => ({
      join: async (_b: string, _a: string, req: { exchange_token: string }) => {
        calls.push(req.exchange_token)
        const id = req.exchange_token === 'xt-B' ? 'install-B' : 'install-A'
        return { ok: true as const, data: { ...fresh(id, id), role: 'staff' as const } }
      },
    })
    const server = createJoinPortServer({
      presence: async () => ({ ext_version: '1.4.0', state: 'idle' }),
      hello: (ref, nonce) => prepareChallenge(ref, nonce),
      exchange: (token, nonce) => exchangeJoin(token, nonce, { loadClient }),
    })
    const a = tab(1)
    const b = tab(2)
    server.onConnect(a.port)
    server.onConnect(b.port)

    a.hello('inv-A')
    await vi.waitFor(() => expect(a.last()?.type).toBe('challenge'))
    const challengeA = a.last()!
    b.hello('inv-B') // supersedes A's UNSENT attempt
    await vi.waitFor(() => expect(b.last()?.type).toBe('challenge'))
    const challengeB = b.last()!

    // Tab A's token is bound to a challenge that is no longer ours: refused, no /join.
    a.exchange('xt-A', challengeA.nonce)
    await vi.waitFor(() => expect(a.last()?.type).toBe('result'))
    expect(a.last()?.payload).toEqual({ status: 'failed', error_code: 'recovery_window_expired' })
    expect(calls).toEqual([])

    b.exchange('xt-B', challengeB.nonce)
    await vi.waitFor(() => expect(b.last()?.type).toBe('result'))
    expect(b.last()?.payload).toMatchObject({
      status: 'success',
      connected_invitation_ref: 'inv-B',
    })

    // Tab A tries again: the clinic is never switched.
    const before = a.posted.length
    a.hello('inv-A')
    await vi.waitFor(() => expect(a.posted.length).toBe(before + 2)) // presence + result
    expect(a.posted[before]?.payload).toMatchObject({ state: 'idle' })
    expect(a.last()).toMatchObject({
      type: 'result',
      payload: { status: 'failed', error_code: 'already_enrolled' },
    })
    expect(calls).toEqual(['xt-B'])
    expect((await getEnrollment())?.install_id).toBe('install-B')
  })

  it('while tab A is IN FLIGHT, tab B gets join_pending and A keeps its original attempt', async () => {
    const nonceA = uuidv7()
    const a = await prepareChallenge('inv-A', nonceA, { newSecret: () => 'a'.repeat(43) })
    await exchangeJoin('xt-A', nonceA, {
      loadClient: async () => ({
        join: async () => ({ ok: false as const, code: 'network' as const }),
      }),
    })
    expect(await prepareChallenge('inv-B', uuidv7())).toEqual({
      kind: 'result',
      result: { status: 'failed', error_code: 'join_pending' },
    })
    // Reconnect of tab A: the SAME original attempt and challenge.
    const again = await prepareChallenge('inv-A', uuidv7(), { newSecret: () => 'b'.repeat(43) })
    expect(again).toMatchObject({
      kind: 'challenge',
      attempt_challenge: a.kind === 'challenge' ? a.attempt_challenge : '',
    })
    expect((await getJoinAttempt())?.attemptSecret).toBe('a'.repeat(43))
  })
})
