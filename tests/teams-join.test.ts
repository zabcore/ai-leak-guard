// Teams Lite (deployment m1) — staff-invitation join, extension side
// (Contract A §4c). Executed against an injected join client; no live backend.

import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  JOIN_CHALLENGE_TTL_MS,
  exchangeJoin,
  hasPendingJoin,
  joinPresenceState,
  prepareChallenge,
  runJoin,
  type JoinDeps,
} from '../src/enterprise/teams-join'
import { join, type JoinCallResult, type JoinRequest } from '../src/enterprise/teams-client'
import {
  JOIN_RESULT_REPLAY_MS,
  deriveChallenge,
  getDeadInvitationCode,
  getJoinAttempt,
  getJoinResult,
  newAttemptSecret,
} from '../src/shared/teams-join-attempt'
import {
  getEnrollment,
  setEnrollment,
  setRevokedNotice,
  getRevokedNotice,
  getRevokeBlock,
  setRevokeBlock,
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
const INV = 'inv-0001'
let nonceSeq = 0
const nextNonce = (): string => `0190f0f0-0000-7000-8000-${String(++nonceSeq).padStart(12, '0')}`
/** Answer a `hello` for INV; returns the challenge and the nonce it was bound to. */
async function begin(deps: JoinDeps = {}, invitationRef = INV) {
  const nonce = nextNonce()
  const out = await prepareChallenge(invitationRef, nonce, deps)
  return { out, nonce, challenge: out.kind === 'challenge' ? out.attempt_challenge : undefined }
}
const ENROLLED = {
  install_id: 'x',
  install_credential: 'y',
  org_id: 'o',
  org_name: 'H',
  base_url: BASE,
}
// Pinned: idempotency_key = base64url(SHA-256("alg-join-idem:" + attempt secret)) — never random.
const IDEM = createHash('sha256').update('alg-join-idem:verifier-secret-1').digest('base64url')

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

describe('prepareChallenge (bridge hello)', () => {
  it('persists the attempt + challenge nonce BEFORE returning, and returns only the challenge', async () => {
    const { out, nonce } = await begin(fixed)
    const stored = await getJoinAttempt()
    expect(stored).toMatchObject({
      attemptSecret: 'verifier-secret-1',
      idempotencyKey: IDEM,
      invitationRef: INV,
      challengeNonces: [nonce],
    })
    expect(out).toEqual({
      kind: 'challenge',
      attempt_challenge: stored?.challenge,
      expires_at: new Date(
        Date.parse(stored?.createdAt as string) + JOIN_CHALLENGE_TTL_MS,
      ).toISOString(),
    })
    expect(JSON.stringify(out)).not.toContain('verifier-secret-1')
  })

  it('reuses an unsent attempt for the same invitation (same challenge + secret), recording each nonce', async () => {
    const a = await begin(fixed)
    const b = await begin({ newSecret: () => 'other' })
    expect(b.out).toEqual(a.out)
    expect(await getJoinAttempt()).toMatchObject({
      attemptSecret: 'verifier-secret-1',
      challengeNonces: [a.nonce, b.nonce],
    })
  })

  it('an unsent attempt for ANOTHER invitation, or a stale one, is replaced', async () => {
    const a = await begin(fixed)
    const other = await begin({ newSecret: () => 'other' }, 'inv-0002')
    expect(other.challenge).not.toBe(a.challenge)
    expect(await getJoinAttempt()).toMatchObject({
      attemptSecret: 'other',
      invitationRef: 'inv-0002',
    })

    const later = Date.now() + JOIN_CHALLENGE_TTL_MS + 1
    const fresh = await begin({ newSecret: () => 'third', now: () => later }, 'inv-0002')
    expect(fresh.challenge).not.toBe(other.challenge)
  })

  it('an IN-FLIGHT attempt re-emits the SAME challenge on reconnect, even when stale', async () => {
    const a = await begin(fixed)
    await exchangeJoin('xt-1', a.nonce, {
      loadClient: joinClient([{ ok: false, code: 'network' }]).loadClient,
    })
    const later = Date.now() + JOIN_CHALLENGE_TTL_MS + 1
    const b = await begin({ newSecret: () => 'other', now: () => later })
    expect(b.challenge).toBe(a.challenge)
    expect((await getJoinAttempt())?.attemptSecret).toBe('verifier-secret-1')
    // ...and a different invitation cannot hijack it.
    expect((await begin({}, 'inv-0002')).out).toEqual({
      kind: 'result',
      result: { status: 'failed', error_code: 'join_pending' },
    })
  })

  it('already enrolled → a failed already_enrolled result for THIS invitation, no attempt', async () => {
    await setEnrollment(ENROLLED)
    expect((await begin(fixed)).out).toEqual({
      kind: 'result',
      result: { status: 'failed', error_code: 'already_enrolled' },
    })
    expect(await getJoinAttempt()).toBeNull()
  })

  it('presence state (pinned §3): idle → awaiting_token → connecting → connected', async () => {
    expect(await joinPresenceState()).toBe('idle')
    const a = await begin(fixed)
    expect(await joinPresenceState()).toBe('awaiting_token')
    await exchangeJoin('xt-1', a.nonce, {
      loadClient: joinClient([{ ok: false, code: 'network' }]).loadClient,
    })
    expect(await joinPresenceState()).toBe('connecting')
    await exchangeJoin('xt-1', a.nonce, { loadClient: joinClient([OK]).loadClient })
    expect(await joinPresenceState()).toBe('connected')
  })

  it('presence state: error after a failed join (within the window) or on a revoked install', async () => {
    const a = await begin(fixed)
    await exchangeJoin('xt-1', a.nonce, {
      loadClient: joinClient([{ ok: false, code: 'invalid_proof' }]).loadClient,
    })
    expect(await joinPresenceState()).toBe('error')
    const later = Date.now() + JOIN_RESULT_REPLAY_MS + 1
    expect(await joinPresenceState({ now: () => later })).toBe('idle')
    await setRevokeBlock()
    expect(await joinPresenceState({ now: () => later })).toBe('error')
  })
})

describe('exchangeJoin (bridge exchange_token)', () => {
  it('success: result carries ALL connected_* fields; the record is kept for replay', async () => {
    const { nonce, challenge } = await begin(fixed)
    const c = joinClient([OK])
    const first = await exchangeJoin('xt-1', nonce, { loadClient: c.loadClient })
    expect(first.enrolledNow).toBe(true)
    expect(first.result).toEqual({
      status: 'success',
      connected_invitation_ref: INV,
      connected_attempt_challenge: challenge,
      connected_org_id: 'org_1',
      connected_org_name: 'Harbor',
      connected_at: expect.any(String),
    })
    expect(JSON.stringify(first)).not.toContain('verifier-secret-1')
    expect(JSON.stringify(first)).not.toContain('c1')
    expect(await getJoinAttempt()).toBeNull()

    // A repeat for the same challenge_nonce is idempotent: same result, no request.
    const again = await exchangeJoin('xt-1', nonce, { loadClient: c.loadClient })
    expect(again).toEqual({ result: first.result, enrolledNow: false })
    expect(c.calls).toHaveLength(1)
  })

  it('after reconnect the page gets the SAME challenge and can replay its token', async () => {
    const a = await begin(fixed)
    const c = joinClient([OK])
    const first = await exchangeJoin('xt-1', a.nonce, { loadClient: c.loadClient })
    const b = await begin({ newSecret: () => 'other' }) // reconnect, same invitation
    expect(b.challenge).toBe(a.challenge)
    expect((await exchangeJoin('xt-1', b.nonce, { loadClient: c.loadClient })).result).toEqual(
      first.result,
    )
    expect(c.calls).toHaveLength(1)
  })

  it('once the replay window has passed, a repeat gets recovery_window_expired', async () => {
    const { nonce } = await begin(fixed)
    await exchangeJoin('xt-1', nonce, { loadClient: joinClient([OK]).loadClient })
    const later = Date.now() + JOIN_RESULT_REPLAY_MS + 1
    expect((await exchangeJoin('xt-1', nonce, { now: () => later })).result).toEqual({
      status: 'failed',
      error_code: 'recovery_window_expired',
    })
  })

  it('a challenge_nonce this extension never emitted is refused WITHOUT calling /join', async () => {
    await begin(fixed)
    const c = joinClient([OK])
    expect((await exchangeJoin('xt-1', nextNonce(), { loadClient: c.loadClient })).result).toEqual({
      status: 'failed',
      error_code: 'recovery_window_expired',
    })
    expect(c.calls).toHaveLength(0)
    expect(await getEnrollment()).toBeNull()
  })

  it('after invalid_proof a NEW hello may start a fresh attempt; the old one stays replayable', async () => {
    const a = await begin(fixed)
    const c = joinClient([{ ok: false, code: 'invalid_proof' }])
    await exchangeJoin('xt-1', a.nonce, { loadClient: c.loadClient })
    // No automatic retry: nothing is minted until the page says hello again.
    expect(await getJoinAttempt()).toBeNull()
    expect(c.calls).toHaveLength(1)
    const b = await begin({ newSecret: () => 'other' })
    expect(b.challenge).not.toBe(a.challenge)
    expect((await exchangeJoin('xt-1', a.nonce)).result).toEqual({
      status: 'failed',
      error_code: 'invalid_proof',
    })
  })

  it('AMENDMENT B: a lapsed exchange token (expired) is RECOVERED with the SAME attempt + new token', async () => {
    const a = await begin(fixed)
    const lapsed = await exchangeJoin('xt-1', a.nonce, {
      loadClient: joinClient([{ ok: false, code: 'expired' }]).loadClient,
    })
    expect(lapsed.result).toEqual({ status: 'failed', error_code: 'expired' })
    // The attempt (secret + challenge + nonces) is kept; only the dead token is dropped.
    const kept = await getJoinAttempt()
    expect(kept).toMatchObject({ attemptSecret: 'verifier-secret-1', challenge: a.challenge })
    expect(kept?.exchangeToken).toBeUndefined()
    // Reconnect re-emits the SAME challenge; a new token redeems with the same secret.
    const b = await begin({ newSecret: () => 'other' })
    expect(b.challenge).toBe(a.challenge)
    const c = joinClient([OK])
    const done = await exchangeJoin('xt-2', b.nonce, { loadClient: c.loadClient })
    expect(done.result).toMatchObject({ status: 'success' })
    expect(c.calls).toEqual([
      { exchange_token: 'xt-2', attempt_secret: 'verifier-secret-1', idempotency_key: IDEM },
    ])
  })

  it.each([
    'install_revoked',
    'recovery_window_expired',
    'invitation_revoked',
    'invitation_expired',
    'invitation_consumed',
  ] as const)(
    '%s NEVER yields a fresh attempt for that invitation, even after the replay window',
    async (code) => {
      const a = await begin(fixed)
      await exchangeJoin('xt-1', a.nonce, {
        loadClient: joinClient([{ ok: false, code }]).loadClient,
      })
      const later = Date.now() + JOIN_RESULT_REPLAY_MS + 1
      for (const now of [Date.now(), later]) {
        expect((await begin({ newSecret: () => 'other', now: () => now })).out).toEqual({
          kind: 'result',
          result: { status: 'failed', error_code: code },
        })
        expect(await getJoinAttempt()).toBeNull()
      }
    },
  )

  it('a revoked install (persistent block) never starts a fresh attempt for any invitation', async () => {
    await setRevokeBlock()
    expect((await begin(fixed, 'inv-0009')).out).toEqual({
      kind: 'result',
      result: { status: 'failed', error_code: 'install_revoked' },
    })
    expect(await getJoinAttempt()).toBeNull()
  })

  it('a lost-response join is recovered with the SAME attempt, never a fresh one', async () => {
    const a = await begin(fixed)
    await exchangeJoin('xt-1', a.nonce, {
      loadClient: joinClient([{ ok: false, code: 'network' }]).loadClient,
    })
    const b = await begin({ newSecret: () => 'other' })
    expect(b.challenge).toBe(a.challenge)
    const c = joinClient([OK])
    const done = await exchangeJoin('xt-NEWER', b.nonce, { loadClient: c.loadClient })
    expect(done.result).toMatchObject({
      status: 'success',
      connected_attempt_challenge: a.challenge,
    })
    expect(c.calls).toEqual([
      { exchange_token: 'xt-1', attempt_secret: 'verifier-secret-1', idempotency_key: IDEM },
    ])
  })

  it('terminal failures are replayed too; network keeps the attempt and is retryable', async () => {
    const a = await begin(fixed)
    const net = await exchangeJoin('xt-1', a.nonce, {
      loadClient: joinClient([{ ok: false, code: 'network' }]).loadClient,
    })
    expect(net.result).toEqual({ status: 'failed', error_code: 'backend_unavailable' })
    expect(await hasPendingJoin()).toBe(true)

    const c = joinClient([{ ok: false, code: 'invalid_proof' }])
    const bad = await exchangeJoin('xt-1', a.nonce, { loadClient: c.loadClient })
    expect(bad.result).toEqual({ status: 'failed', error_code: 'invalid_proof' })
    expect(await getJoinResult()).toMatchObject({ result: bad.result })
    expect((await exchangeJoin('xt-1', a.nonce, { loadClient: c.loadClient })).result).toEqual(
      bad.result,
    )
    expect(c.calls).toHaveLength(1)
  })
})

// Acceptance review: a NEW hello (fresh envelope nonce) on an already-enrolled
// install must never mint an attempt, mutate the enrollment, or touch a pending one.
describe('new hello on an already-enrolled install (binding + recovery-first)', () => {
  it('within the replay window: the SAME attempt_challenge, no attempt, enrollment unchanged, no /join', async () => {
    const a = await begin(fixed)
    const c = joinClient([OK])
    const first = await exchangeJoin('xt-1', a.nonce, { loadClient: c.loadClient })
    const enrolled = await getEnrollment()
    expect(enrolled).toMatchObject({ install_id: 'i1' })

    const probe = await begin({ newSecret: () => 'probe-secret' })
    expect(probe.nonce).not.toBe(a.nonce)
    expect(probe.challenge).toBe(a.challenge) // re-emitted, not minted
    expect(await getJoinAttempt()).toBeNull()

    // Any token sent against the probe's challenge only replays the stored result.
    const replay = await exchangeJoin('xt-other', probe.nonce, { loadClient: c.loadClient })
    expect(replay).toEqual({ result: first.result, enrolledNow: false })
    expect(c.calls).toHaveLength(1)
    expect(await getEnrollment()).toEqual(enrolled)
  })

  it('another invitation, or after the replay window: already_enrolled, nothing written', async () => {
    const a = await begin(fixed)
    await exchangeJoin('xt-1', a.nonce, { loadClient: joinClient([OK]).loadClient })
    const enrolled = await getEnrollment()
    const settled = await getJoinResult()
    const later = Date.now() + JOIN_RESULT_REPLAY_MS + 1
    for (const out of [
      (await begin({}, 'inv-0002')).out,
      (await begin({ now: () => later })).out,
    ]) {
      expect(out).toEqual({
        kind: 'result',
        result: { status: 'failed', error_code: 'already_enrolled' },
      })
    }
    expect(await getJoinAttempt()).toBeNull()
    expect(await getEnrollment()).toEqual(enrolled)
    expect(await getJoinResult()).toEqual(settled)
  })

  it('a pending attempt is neither replaced nor mutated by a new hello, and never redeemed', async () => {
    const a = await begin(fixed)
    await exchangeJoin('xt-1', a.nonce, {
      loadClient: joinClient([{ ok: false, code: 'network' }]).loadClient,
    })
    const pending = await getJoinAttempt()
    expect(pending?.exchangeToken).toBe('xt-1')
    await setEnrollment(ENROLLED) // enrolled by another path (code entry / policy)

    for (const inv of [INV, 'inv-0002']) {
      expect((await begin({ newSecret: () => 'probe-secret' }, inv)).out).toEqual({
        kind: 'result',
        result: { status: 'failed', error_code: 'already_enrolled' },
      })
    }
    expect(await getJoinAttempt()).toEqual(pending)
    const c = joinClient([OK])
    expect(await runJoin(undefined, { loadClient: c.loadClient })).toBe('already-enrolled')
    expect(c.calls).toHaveLength(0)
    expect(await getEnrollment()).toEqual(ENROLLED)
  })
})

describe('join idempotency_key derivation (pinned, domain-tagged)', () => {
  it('differs from the S256 challenge the website holds', async () => {
    const { challenge } = await begin(fixed)
    expect(challenge).toBe(createHash('sha256').update('verifier-secret-1').digest('base64url'))
    expect(IDEM).not.toBe(challenge)
  })

  it('install_revoked sets the persistent no-reenroll block; other terminal errors do not', async () => {
    await begin(fixed)
    await runJoin('xt-1', { loadClient: joinClient([{ ok: false, code: 'expired' }]).loadClient })
    expect(await getRevokeBlock()).toBe(false)
    await begin(fixed)
    await runJoin('xt-2', {
      loadClient: joinClient([{ ok: false, code: 'install_revoked' }]).loadClient,
    })
    expect(await getRevokeBlock()).toBe(true)
  })

  it('is base64url(SHA-256(attempt secret)) and identical on every retry of the attempt', async () => {
    await begin(fixed)
    const c = joinClient([{ ok: false, code: 'network' }, { ok: false, code: 'network' }, OK])
    await runJoin('xt-1', { loadClient: c.loadClient })
    await runJoin(undefined, { loadClient: c.loadClient })
    await runJoin('xt-1', { loadClient: c.loadClient })
    expect(c.calls.map((x) => x.idempotency_key)).toEqual([IDEM, IDEM, IDEM])
  })

  it('a fresh random secret still yields its derived (not random) key', async () => {
    await begin()
    const secret = (await getJoinAttempt())?.attemptSecret as string
    const c = joinClient([OK])
    await runJoin('xt-1', { loadClient: c.loadClient })
    expect(c.calls[0]?.idempotency_key).toBe(
      createHash('sha256').update(`alg-join-idem:${secret}`).digest('base64url'),
    )
  })
})

describe('runJoin', () => {
  it('sends {exchange_token, attempt_secret, idempotency_key}, stores the credential, clears the attempt', async () => {
    await setRevokedNotice(true)
    await begin(fixed)
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
    await begin(fixed)
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
    ['install_revoked', 'install-revoked'],
    ['recovery_window_expired', 'recovery-expired'],
    ['invitation_revoked', 'invitation-dead'],
    ['invitation_expired', 'invitation-dead'],
    ['invitation_consumed', 'invitation-dead'],
  ] as const)('terminal %s → %s, clears the attempt, never enrolls', async (code, outcome) => {
    await begin(fixed)
    const c = joinClient([{ ok: false, code }])
    expect(await runJoin('xt-1', { loadClient: c.loadClient })).toBe(outcome)
    expect(await getJoinAttempt()).toBeNull()
    expect(await getEnrollment()).toBeNull()
  })

  it('expired (lapsed token) is NOT terminal: the attempt is kept, never enrolls', async () => {
    await begin(fixed)
    const c = joinClient([{ ok: false, code: 'expired' }])
    expect(await runJoin('xt-1', { loadClient: c.loadClient })).toBe('expired')
    expect(await getJoinAttempt()).toMatchObject({ attemptSecret: 'verifier-secret-1' })
    expect(await getEnrollment()).toBeNull()
  })

  // INVARIANT 3: the client distinguishes every /join sub-code and never
  // collapses one into an install revocation.
  it.each([
    ['expired', { block: false, attemptKept: true, deadInvitation: false }],
    ['invalid_proof', { block: false, attemptKept: false, deadInvitation: false }],
    ['install_revoked', { block: true, attemptKept: false, deadInvitation: true }],
    ['recovery_window_expired', { block: false, attemptKept: false, deadInvitation: true }],
    ['invitation_revoked', { block: false, attemptKept: false, deadInvitation: true }],
    ['invitation_expired', { block: false, attemptKept: false, deadInvitation: true }],
    ['invitation_consumed', { block: false, attemptKept: false, deadInvitation: true }],
  ] as const)(
    'INVARIANT 3: %s → its own handling (block / keep attempt / dead invitation)',
    async (code, want) => {
      const a = await begin(fixed)
      const res = await exchangeJoin('xt-1', a.nonce, {
        loadClient: joinClient([{ ok: false, code }]).loadClient,
      })
      expect(res.result).toEqual({ status: 'failed', error_code: code })
      expect(await getRevokeBlock()).toBe(want.block)
      expect((await getJoinAttempt()) !== null).toBe(want.attemptKept)
      expect(await getDeadInvitationCode(INV)).toBe(want.deadInvitation ? code : null)
    },
  )

  it('without a minted attempt there is nothing to redeem (no network)', async () => {
    const c = joinClient()
    expect(await runJoin('xt-1', { loadClient: c.loadClient })).toBe('no-attempt')
    expect(c.calls).toHaveLength(0)
  })

  it('already enrolled → no request', async () => {
    await begin(fixed)
    await setEnrollment(ENROLLED)
    const c = joinClient()
    expect(await runJoin('xt-1', { loadClient: c.loadClient })).toBe('already-enrolled')
    expect(c.calls).toHaveLength(0)
  })

  it('queues concurrent completes: ONE request, the later call is a no-op', async () => {
    await begin(fixed)
    const c = joinClient([OK])
    const [a, b] = await Promise.all([
      runJoin('xt-1', { loadClient: c.loadClient }),
      runJoin('xt-1', { loadClient: c.loadClient }),
    ])
    expect([a, b]).toEqual(['enrolled', 'already-enrolled'])
    expect(c.calls).toHaveLength(1)
  })

  it('a handoff arriving DURING a startup recovery keeps its own token (not dropped)', async () => {
    await begin(fixed) // attempt minted, no exchange token yet
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
      [410, { error: 'install_revoked' }, 'install_revoked'],
      [410, { error: 'revoked' }, 'expired'],
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
