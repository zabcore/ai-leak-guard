// Teams Lite (deployment m1) — staff-invitation join, extension side
// (Contract A §4c). Executed against an injected join client; no live backend.

import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { beginJoin, hasPendingJoin, runJoin } from '../src/enterprise/teams-join'
import { join, type JoinCallResult, type JoinRequest } from '../src/enterprise/teams-client'
import { deriveChallenge, getJoinAttempt, newAttemptSecret } from '../src/shared/teams-join-attempt'
import {
  getEnrollment,
  setEnrollment,
  setRevokedNotice,
  getRevokedNotice,
} from '../src/shared/teams-storage'

const BASE = 'http://127.0.0.1:54321'
const OK: JoinCallResult = {
  ok: true,
  data: {
    install_id: 'i1',
    install_credential: 'c1',
    org_id: 'org_1',
    org_name: 'Harbor',
    role: 'staff',
  },
}

function joinClient(results: JoinCallResult[] = []) {
  const calls: JoinRequest[] = []
  const loadClient = async () => ({
    join: async (_b: string, _a: string, req: JoinRequest) => {
      calls.push(req)
      return results.shift() ?? OK
    },
  })
  return { loadClient, calls }
}

const fixed = { newSecret: () => 'verifier-secret-1' }
// Pinned: idempotency_key = base64url(SHA-256(attempt secret)) — never random.
const IDEM = createHash('sha256').update('verifier-secret-1').digest('base64url')

beforeEach(() => {
  vi.stubEnv('VITE_TEAMS_BASE_URL', BASE)
  vi.stubEnv('VITE_TEAMS_ANON_KEY', 'anon')
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  delete (globalThis as { fetch?: unknown }).fetch
})

describe('attempt secret + S256 challenge', () => {
  it('secret is 32 random bytes base64url; challenge = base64url(SHA256(secret))', async () => {
    const s = newAttemptSecret()
    expect(s).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(newAttemptSecret()).not.toBe(s)
    const expected = createHash('sha256').update(s).digest('base64url')
    expect(await deriveChallenge(s)).toBe(expected)
  })
})

describe('beginJoin', () => {
  it('persists the attempt BEFORE returning, and returns only the challenge', async () => {
    const r = await beginJoin(fixed)
    const stored = await getJoinAttempt()
    expect(stored).toMatchObject({ attemptSecret: 'verifier-secret-1', idempotencyKey: IDEM })
    expect(r).toEqual({ ok: true, challenge: stored?.challenge })
    expect(JSON.stringify(r)).not.toContain('verifier-secret-1')
  })

  it('reuses an unsent attempt (same challenge, same secret) across repeated begins', async () => {
    const a = await beginJoin(fixed)
    const b = await beginJoin({ newSecret: () => 'other' })
    expect(b).toEqual(a)
    expect((await getJoinAttempt())?.attemptSecret).toBe('verifier-secret-1')
  })

  it('refuses when already enrolled (no silent clinic transfer)', async () => {
    await setEnrollment({
      install_id: 'x',
      install_credential: 'y',
      org_id: 'o',
      org_name: 'H',
      base_url: BASE,
    })
    expect(await beginJoin(fixed)).toEqual({ ok: false, error: 'already_enrolled' })
    expect(await getJoinAttempt()).toBeNull()
  })

  it('reports join_pending while a sent attempt awaits recovery', async () => {
    await beginJoin(fixed)
    await runJoin('xt-1', { loadClient: joinClient([{ ok: false, code: 'network' }]).loadClient })
    expect(await beginJoin(fixed)).toEqual({ ok: false, error: 'join_pending' })
  })
})

describe('join idempotency_key derivation (pinned, same as /provision)', () => {
  it('is base64url(SHA-256(attempt secret)) and identical on every retry of the attempt', async () => {
    await beginJoin(fixed)
    const c = joinClient([{ ok: false, code: 'network' }, { ok: false, code: 'network' }, OK])
    await runJoin('xt-1', { loadClient: c.loadClient })
    await runJoin(undefined, { loadClient: c.loadClient })
    await runJoin('xt-1', { loadClient: c.loadClient })
    expect(c.calls.map((x) => x.idempotency_key)).toEqual([IDEM, IDEM, IDEM])
  })

  it('a fresh random secret still yields its derived (not random) key', async () => {
    await beginJoin()
    const secret = (await getJoinAttempt())?.attemptSecret as string
    const c = joinClient([OK])
    await runJoin('xt-1', { loadClient: c.loadClient })
    expect(c.calls[0]?.idempotency_key).toBe(
      createHash('sha256').update(secret).digest('base64url'),
    )
  })
})

describe('runJoin', () => {
  it('sends {exchange_token, attempt_secret, idempotency_key}, stores the credential, clears the attempt', async () => {
    await setRevokedNotice(true)
    await beginJoin(fixed)
    const c = joinClient([OK])
    expect(await runJoin('xt-1', { loadClient: c.loadClient })).toBe('enrolled')
    expect(c.calls).toEqual([
      { exchange_token: 'xt-1', attempt_secret: 'verifier-secret-1', idempotency_key: IDEM },
    ])
    expect(await getEnrollment()).toEqual({
      install_id: 'i1',
      install_credential: 'c1',
      org_id: 'org_1',
      org_name: 'Harbor',
      base_url: BASE,
    })
    expect(await getRevokedNotice()).toBe(false)
    expect(await getJoinAttempt()).toBeNull()
  })

  it('REUSES the same attempt on retry after a lost response (worker restart)', async () => {
    await beginJoin(fixed)
    const first = joinClient([{ ok: false, code: 'network' }])
    expect(await runJoin('xt-1', { loadClient: first.loadClient })).toBe('network')
    expect(await hasPendingJoin()).toBe(true)
    expect(await getJoinAttempt()).toMatchObject({ exchangeToken: 'xt-1' })

    // Recovery with no token (startup) AND with a newer token both re-send the
    // SAME attempt + the persisted token (recovery-ordering rule).
    const retry = joinClient([{ ok: false, code: 'network' }, OK])
    expect(await runJoin(undefined, { loadClient: retry.loadClient })).toBe('network')
    expect(await runJoin('xt-NEWER', { loadClient: retry.loadClient })).toBe('enrolled')
    for (const call of retry.calls) expect(call).toEqual(first.calls[0])
  })

  it.each([
    ['invalid_proof', 'invalid-proof'],
    ['expired', 'expired'],
    ['revoked', 'revoked'],
    ['recovery_window_expired', 'recovery-expired'],
  ] as const)('terminal %s → %s, clears the attempt, never enrolls', async (code, outcome) => {
    await beginJoin(fixed)
    const c = joinClient([{ ok: false, code }])
    expect(await runJoin('xt-1', { loadClient: c.loadClient })).toBe(outcome)
    expect(await getJoinAttempt()).toBeNull()
    expect(await getEnrollment()).toBeNull()
  })

  it('without a minted attempt there is nothing to redeem (no network)', async () => {
    const c = joinClient()
    expect(await runJoin('xt-1', { loadClient: c.loadClient })).toBe('no-attempt')
    expect(c.calls).toHaveLength(0)
  })

  it('already enrolled → no request', async () => {
    await beginJoin(fixed)
    await setEnrollment({
      install_id: 'x',
      install_credential: 'y',
      org_id: 'o',
      org_name: 'H',
      base_url: BASE,
    })
    const c = joinClient()
    expect(await runJoin('xt-1', { loadClient: c.loadClient })).toBe('already-enrolled')
    expect(c.calls).toHaveLength(0)
  })

  it('queues concurrent completes: ONE request, the later call is a no-op', async () => {
    await beginJoin(fixed)
    const c = joinClient([OK])
    const [a, b] = await Promise.all([
      runJoin('xt-1', { loadClient: c.loadClient }),
      runJoin('xt-1', { loadClient: c.loadClient }),
    ])
    expect([a, b]).toEqual(['enrolled', 'already-enrolled'])
    expect(c.calls).toHaveLength(1)
  })

  it('a handoff arriving DURING a startup recovery keeps its own token (not dropped)', async () => {
    await beginJoin(fixed) // attempt minted, no exchange token yet
    const c = joinClient([OK])
    const [recovery, handoff] = await Promise.all([
      runJoin(undefined, { loadClient: c.loadClient }),
      runJoin('xt-1', { loadClient: c.loadClient }),
    ])
    expect(recovery).toBe('no-exchange-token')
    expect(handoff).toBe('enrolled')
    expect(c.calls).toEqual([
      { exchange_token: 'xt-1', attempt_secret: 'verifier-secret-1', idempotency_key: IDEM },
    ])
  })
})

describe('teams-client join()', () => {
  function res(status: number, body: unknown): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as unknown as Response
  }
  const REQ = { exchange_token: 'xt', attempt_secret: 'sec', idempotency_key: 'k' }

  it('POSTs the body to /functions/v1/join; the secret is never in the URL', async () => {
    const fetchMock = vi.fn(async () => res(200, OK.ok ? OK.data : {}))
    ;(globalThis as { fetch: unknown }).fetch = fetchMock
    expect(await join(BASE, 'anon', REQ)).toEqual(OK)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${BASE}/functions/v1/join`)
    expect(url).not.toContain('sec')
    expect(JSON.parse(init.body as string)).toEqual(REQ)
  })

  it('maps status codes; a non-staff role or malformed body is not a success', async () => {
    const cases: Array<[number, unknown, string]> = [
      [401, { error: 'invalid_proof' }, 'invalid_proof'],
      [410, { error: 'expired' }, 'expired'],
      [410, { error: 'revoked' }, 'revoked'],
      [410, { error: 'recovery_window_expired' }, 'recovery_window_expired'],
      [500, {}, 'network'],
      [
        200,
        { install_id: 'i', install_credential: 'c', org_id: 'o', org_name: 'H', role: 'admin' },
        'network',
      ],
    ]
    for (const [status, body, code] of cases) {
      ;(globalThis as { fetch: unknown }).fetch = vi.fn(async () => res(status, body))
      expect(await join(BASE, 'anon', REQ)).toEqual({ ok: false, code })
    }
    ;(globalThis as { fetch: unknown }).fetch = vi.fn(async () => {
      throw new Error('offline')
    })
    expect(await join(BASE, 'anon', REQ)).toEqual({ ok: false, code: 'network' })
  })
})
