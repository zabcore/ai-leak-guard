// Teams Lite (deployment m1) — the bridge/1.1.0 join port (`zc.join.v1`):
// transport, envelope rules and message types, with injected deps, plus the
// service-worker wiring against the real join logic. No live backend.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BRIDGE_NS,
  JOIN_PORT_NAME,
  JOIN_PORT_ORIGINS,
  MAX_MESSAGE_AGE_MS,
  NONCE_DEDUP_MS,
  createJoinPortServer,
  uuidv7,
  type JoinPort,
  type JoinPortDeps,
  type PortSender,
} from '../src/background/teams-join-port'
import { exchangeJoin, prepareChallenge } from '../src/enterprise/teams-join'
import { getJoinAttempt } from '../src/shared/teams-join-attempt'
import { getEnrollment } from '../src/shared/teams-storage'

const BASE = 'http://127.0.0.1:54321'
const ZAB: PortSender = {
  origin: 'https://zabcore.com',
  url: 'https://zabcore.com/join?invitation_ref=inv-1',
  tab: { id: 7 },
}
const UUID7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

type Posted = {
  ns: string
  v: number
  type: string
  nonce: string
  ts: string
  payload: Record<string, unknown>
}

function fakePort(sender: PortSender | null = ZAB, name = JOIN_PORT_NAME) {
  const posted: Posted[] = []
  let onMsg: ((m: unknown) => void) | undefined
  const onDisc: Array<() => void> = []
  const state = { disconnected: false }
  const port: JoinPort & { sender?: PortSender } = {
    name,
    ...(sender !== null ? { sender } : {}),
    postMessage: (m) => posted.push(m as Posted),
    disconnect: () => {
      state.disconnected = true
      for (const f of onDisc) f()
    },
    onMessage: { addListener: (f) => (onMsg = f) },
    onDisconnect: { addListener: (f) => onDisc.push(f) },
  }
  return {
    port,
    posted,
    state,
    types: () => posted.map((p) => p.type),
    send: (m: unknown) => onMsg?.(m),
  }
}

function w(type: string, payload: Record<string, unknown>, over: Partial<Posted> = {}) {
  return {
    ns: BRIDGE_NS,
    v: 1,
    type,
    nonce: uuidv7(),
    ts: new Date().toISOString(),
    payload,
    ...over,
  }
}
const HELLO = () => w('hello', { invitation_ref: 'inv-1', locale: 'en' })

function stubDeps(over: Partial<JoinPortDeps> = {}) {
  const calls = { hello: [] as string[][], exchange: [] as string[][] }
  const deps: JoinPortDeps = {
    presence: async () => ({ ext_version: '1.4.0', state: 'unenrolled' }),
    hello: async (ref, nonce) => {
      calls.hello.push([ref, nonce])
      return {
        kind: 'challenge',
        attempt_challenge: 'CHAL',
        expires_at: '2030-01-01T00:00:00.000Z',
      }
    },
    exchange: async (token, nonce) => {
      calls.exchange.push([token, nonce])
      return {
        enrolledNow: true,
        result: {
          status: 'success',
          connected_invitation_ref: 'inv-1',
          connected_attempt_challenge: 'CHAL',
          connected_org_id: 'o',
          connected_org_name: 'H',
          connected_at: '2030-01-01T00:00:00.000Z',
        },
      }
    },
    ...over,
  }
  return { deps, calls }
}

describe('join port — transport (§1)', () => {
  it('allowlist is the production apex origin only', () => {
    expect(JOIN_PORT_ORIGINS).toEqual(['https://zabcore.com'])
  })

  it.each([
    ['another site', { origin: 'https://evil.example', url: 'https://evil.example/join' }],
    ['www', { origin: 'https://www.zabcore.com', url: 'https://www.zabcore.com/join' }],
    ['http', { origin: 'http://zabcore.com', url: 'http://zabcore.com/join' }],
    ['not a join page', { origin: 'https://zabcore.com', url: 'https://zabcore.com/pricing' }],
    ['origin/url disagree', { origin: 'https://evil.example', url: 'https://zabcore.com/join' }],
    ['no sender', null],
  ])('rejects %s on connect with bad_origin and closes', async (_label, sender) => {
    const { deps, calls } = stubDeps()
    const p = fakePort(sender as PortSender | null)
    createJoinPortServer(deps).onConnect(p.port)
    expect(p.types()).toEqual(['error'])
    expect(p.posted[0]?.payload).toEqual({ code: 'bad_origin' })
    expect(p.state.disconnected).toBe(true)
    p.send(HELLO())
    await new Promise((r) => setTimeout(r, 0))
    expect(calls.hello).toHaveLength(0)
  })

  it('re-checks the origin on EVERY inbound message', async () => {
    const { deps, calls } = stubDeps()
    const p = fakePort({ ...ZAB })
    createJoinPortServer(deps).onConnect(p.port)
    ;(p.port as { sender?: PortSender }).sender = {
      origin: 'https://evil.example',
      url: 'https://evil.example/join',
    }
    p.send(HELLO())
    await vi.waitFor(() => expect(p.state.disconnected).toBe(true))
    expect(p.posted.map((x) => x.payload)).toEqual([{ code: 'bad_origin' }])
    expect(calls.hello).toHaveLength(0)
  })

  it('ignores ports with another name', () => {
    const p = fakePort(ZAB, 'something-else')
    createJoinPortServer(stubDeps().deps).onConnect(p.port)
    expect(p.posted).toHaveLength(0)
  })

  it('keeps ONE port per tab: a new port from the same tab closes the old one', () => {
    const server = createJoinPortServer(stubDeps().deps)
    const a = fakePort()
    const b = fakePort()
    const other = fakePort({ ...ZAB, tab: { id: 8 } })
    server.onConnect(a.port)
    server.onConnect(other.port)
    server.onConnect(b.port)
    expect(a.state.disconnected).toBe(true)
    expect(b.state.disconnected).toBe(false)
    expect(other.state.disconnected).toBe(false)
  })
})

describe('join port — envelope (§2)', () => {
  it('every outbound message is a full envelope with a UUIDv7 nonce and ISO ts', async () => {
    const p = fakePort()
    createJoinPortServer(stubDeps().deps).onConnect(p.port)
    p.send(HELLO())
    await vi.waitFor(() => expect(p.posted).toHaveLength(2))
    for (const m of p.posted) {
      expect(Object.keys(m).sort()).toEqual(['nonce', 'ns', 'payload', 'ts', 'type', 'v'])
      expect(m.ns).toBe('zc.join')
      expect(m.v).toBe(1)
      expect(m.nonce).toMatch(UUID7)
      expect(new Date(m.ts).toISOString()).toBe(m.ts)
    }
    expect(new Set(p.posted.map((m) => m.nonce)).size).toBe(2)
  })

  it('REJECTS the retired one-shot {type:"alg-join-complete"} message (no exchange)', async () => {
    const { deps, calls } = stubDeps()
    const p = fakePort()
    createJoinPortServer(deps).onConnect(p.port)
    p.send({ type: 'alg-join-complete', exchange_token: 'xt-1' })
    await vi.waitFor(() => expect(p.posted).toHaveLength(1))
    expect(p.posted[0]).toMatchObject({ type: 'error', payload: { code: 'invalid_message' } })
    // Also inside a valid envelope: an unknown type, never routed to /join.
    p.send(w('alg-join-complete', { exchange_token: 'xt-1' }))
    await vi.waitFor(() => expect(p.posted).toHaveLength(2))
    expect(p.posted[1]).toMatchObject({ type: 'error', payload: { code: 'invalid_message' } })
    expect(calls.exchange).toHaveLength(0)
    expect(p.state.disconnected).toBe(false)
  })

  it('unsupported v → unsupported_version and close', async () => {
    const p = fakePort()
    createJoinPortServer(stubDeps().deps).onConnect(p.port)
    p.send(w('hello', { invitation_ref: 'inv-1' }, { v: 2 }))
    await vi.waitFor(() => expect(p.state.disconnected).toBe(true))
    expect(p.posted.map((x) => x.payload)).toEqual([{ code: 'unsupported_version' }])
  })

  it('unknown ns or type → invalid_message, port stays open', async () => {
    const p = fakePort()
    createJoinPortServer(stubDeps().deps).onConnect(p.port)
    p.send(w('hello', { invitation_ref: 'inv-1' }, { ns: 'other' }))
    p.send(w('presence', {}))
    p.send(w('hello', { invitation_ref: 'inv-1' }, { nonce: 'short' }))
    await vi.waitFor(() => expect(p.posted).toHaveLength(3))
    expect(p.posted.map((x) => x.payload)).toEqual([
      { code: 'invalid_message' },
      { code: 'invalid_message' },
      { code: 'invalid_message' },
    ])
    expect(p.state.disconnected).toBe(false)
  })

  it('dedups a nonce seen in the last 60 s; drops messages older than 5 min', async () => {
    let now = Date.parse('2030-01-01T00:00:00Z')
    const { deps, calls } = stubDeps({ now: () => now })
    const p = fakePort()
    createJoinPortServer(deps).onConnect(p.port)
    const hello = w('hello', { invitation_ref: 'inv-1' }, { ts: new Date(now).toISOString() })
    p.send(hello)
    p.send(hello)
    await vi.waitFor(() => expect(p.posted).toHaveLength(2))
    await new Promise((r) => setTimeout(r, 0))
    expect(calls.hello).toHaveLength(1)

    now += NONCE_DEDUP_MS + 1 // the nonce is forgotten after 60 s (still < 5 min old)
    p.send(hello)
    await vi.waitFor(() => expect(calls.hello).toHaveLength(2))

    p.send(
      w(
        'hello',
        { invitation_ref: 'inv-1' },
        { ts: new Date(now - MAX_MESSAGE_AGE_MS - 1).toISOString() },
      ),
    )
    await new Promise((r) => setTimeout(r, 0))
    expect(calls.hello).toHaveLength(2)
  })
})

describe('join port — message types (§3)', () => {
  it('hello → presence, THEN a separate challenge whose envelope nonce was persisted', async () => {
    const { deps, calls } = stubDeps()
    const p = fakePort()
    createJoinPortServer(deps).onConnect(p.port)
    p.send(HELLO())
    await vi.waitFor(() => expect(p.posted).toHaveLength(2))
    expect(p.types()).toEqual(['presence', 'challenge'])
    expect(p.posted[0]?.payload).toEqual({ ext_version: '1.4.0', state: 'unenrolled' })
    expect(p.posted[1]?.payload).toEqual({
      attempt_challenge: 'CHAL',
      expires_at: '2030-01-01T00:00:00.000Z',
    })
    // The nonce handed to the join logic IS the challenge envelope's nonce.
    expect(calls.hello).toEqual([['inv-1', p.posted[1]?.nonce]])
  })

  it('hello that cannot proceed (already enrolled) → presence then a failed result', async () => {
    const { deps } = stubDeps({
      hello: async () => ({
        kind: 'result',
        result: { status: 'failed', error_code: 'already_enrolled' },
      }),
    })
    const p = fakePort()
    createJoinPortServer(deps).onConnect(p.port)
    p.send(HELLO())
    await vi.waitFor(() => expect(p.posted).toHaveLength(2))
    expect(p.types()).toEqual(['presence', 'result'])
    expect(p.posted[1]?.payload).toEqual({ status: 'failed', error_code: 'already_enrolled' })
  })

  it('exchange_token → ack {nonce_of} BEFORE the result; challenge_nonce is passed through', async () => {
    let releaseExchange: () => void = () => {}
    const gate = new Promise<void>((r) => (releaseExchange = r))
    const base = stubDeps()
    const { deps } = stubDeps({
      exchange: async (t, n) => {
        await gate
        return base.deps.exchange(t, n)
      },
    })
    const p = fakePort()
    createJoinPortServer(deps).onConnect(p.port)
    const challengeNonce = uuidv7()
    const msg = w('exchange_token', {
      exchange_token: 'xt-1',
      expires_at: '2030-01-01T00:02:00.000Z',
      challenge_nonce: challengeNonce,
    })
    p.send(msg)
    await vi.waitFor(() => expect(p.posted).toHaveLength(1))
    expect(p.posted[0]).toMatchObject({ type: 'ack', payload: { nonce_of: msg.nonce } })
    releaseExchange()
    await vi.waitFor(() => expect(p.posted).toHaveLength(2))
    expect(p.posted[1]).toMatchObject({
      type: 'result',
      payload: { status: 'success', connected_org_id: 'o', connected_attempt_challenge: 'CHAL' },
    })
    expect(base.calls.exchange).toEqual([['xt-1', challengeNonce]])
  })

  it.each([
    ['missing challenge_nonce', { exchange_token: 'xt', expires_at: 'x' }],
    ['missing expires_at', { exchange_token: 'xt', challenge_nonce: uuidv7() }],
    ['empty token', { exchange_token: '', expires_at: 'x', challenge_nonce: uuidv7() }],
    [
      'oversized token',
      { exchange_token: 'x'.repeat(4097), expires_at: 'x', challenge_nonce: uuidv7() },
    ],
  ])('exchange_token with %s → invalid_message, no ack, no exchange', async (_l, payload) => {
    const { deps, calls } = stubDeps()
    const p = fakePort()
    createJoinPortServer(deps).onConnect(p.port)
    p.send(w('exchange_token', payload))
    await vi.waitFor(() => expect(p.posted).toHaveLength(1))
    expect(p.posted[0]).toMatchObject({ type: 'error', payload: { code: 'invalid_message' } })
    expect(calls.exchange).toHaveLength(0)
  })

  it('a throwing exchange still answers with a failed result', async () => {
    const { deps } = stubDeps({ exchange: async () => Promise.reject(new Error('boom')) })
    const p = fakePort()
    createJoinPortServer(deps).onConnect(p.port)
    p.send(
      w('exchange_token', { exchange_token: 'xt', expires_at: 'x', challenge_nonce: uuidv7() }),
    )
    await vi.waitFor(() => expect(p.posted).toHaveLength(2))
    expect(p.posted[1]).toMatchObject({
      type: 'result',
      payload: { status: 'failed', error_code: 'internal' },
    })
  })
})

describe('join port + real join logic — end to end', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_TEAMS_BASE_URL', BASE)
    vi.stubEnv('VITE_TEAMS_ANON_KEY', 'anon')
  })
  afterEach(() => vi.unstubAllEnvs())

  it('the attempt secret and install credential never cross the port; reconnect replays', async () => {
    const backendCalls: Array<{ attempt_secret: string }> = []
    const loadClient = async () => ({
      join: async (_b: string, _a: string, req: { attempt_secret: string }) => {
        backendCalls.push(req)
        return {
          ok: true as const,
          data: {
            install_id: 'i',
            install_credential: 'CRED-SECRET',
            org_id: 'o',
            org_name: 'H',
            role: 'staff' as const,
          },
        }
      },
    })
    const server = createJoinPortServer({
      presence: async () => ({ ext_version: '1.4.0', state: 'unenrolled' }),
      hello: (ref, nonce) => prepareChallenge(ref, nonce),
      exchange: (token, nonce) => exchangeJoin(token, nonce, { loadClient }),
    })

    const a = fakePort()
    server.onConnect(a.port)
    a.send(HELLO())
    await vi.waitFor(() => expect(a.types()).toEqual(['presence', 'challenge']))
    const challenge = a.posted[1] as Posted
    const secret = (await getJoinAttempt())?.attemptSecret as string
    a.send(
      w('exchange_token', {
        exchange_token: 'xt-1',
        expires_at: 'x',
        challenge_nonce: challenge.nonce,
      }),
    )
    await vi.waitFor(() => expect(a.types()).toEqual(['presence', 'challenge', 'ack', 'result']))
    expect(a.posted[3]?.payload).toMatchObject({
      status: 'success',
      connected_invitation_ref: 'inv-1',
      connected_attempt_challenge: challenge.payload.attempt_challenge,
    })
    expect(backendCalls).toEqual([expect.objectContaining({ attempt_secret: secret })])

    // Port drops; the page reconnects, says hello again, and replays its token.
    a.port.disconnect()
    const b = fakePort()
    server.onConnect(b.port)
    b.send(HELLO())
    await vi.waitFor(() => expect(b.types()).toEqual(['presence', 'challenge']))
    expect(b.posted[1]?.payload.attempt_challenge).toBe(challenge.payload.attempt_challenge)
    b.send(
      w('exchange_token', {
        exchange_token: 'xt-1',
        expires_at: 'x',
        challenge_nonce: b.posted[1]?.nonce,
      }),
    )
    await vi.waitFor(() => expect(b.types()).toHaveLength(4))
    expect(b.posted[3]?.payload).toEqual(a.posted[3]?.payload)
    expect(backendCalls).toHaveLength(1)

    const pageView = JSON.stringify([...a.posted, ...b.posted])
    expect(pageView).not.toContain(secret)
    expect(pageView).not.toContain('CRED-SECRET')
    expect(await getEnrollment()).toMatchObject({ install_credential: 'CRED-SECRET' })
  })
})

describe('service worker — onConnectExternal wiring', () => {
  type ConnectListener = (port: unknown) => void
  const runtime = (
    globalThis as unknown as {
      chrome: {
        runtime: {
          onConnectExternal: { __listeners: ConnectListener[] }
          onMessageExternal: { __listeners: unknown[] }
        }
      }
    }
  ).chrome.runtime

  let fetchSpy: ReturnType<typeof vi.fn>
  beforeAll(async () => {
    await import('../src/background/service-worker')
  })
  beforeEach(() => {
    vi.stubEnv('VITE_TEAMS_BASE_URL', BASE)
    vi.stubEnv('VITE_TEAMS_ANON_KEY', 'anon')
    fetchSpy = vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () =>
        url.endsWith('/join')
          ? {
              install_id: 'i1',
              install_credential: 'c1',
              org_id: 'o',
              org_name: 'H',
              role: 'staff',
            }
          : { revoked: false, org_id: 'o', target_settings_revision: 0, settings: {} },
    }))
    ;(globalThis as { fetch: unknown }).fetch = fetchSpy
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    delete (globalThis as { fetch?: unknown }).fetch
  })

  it('registers NO onMessageExternal receiver (the alg-join-complete path is gone)', () => {
    expect(runtime.onMessageExternal.__listeners).toHaveLength(0)
    expect(runtime.onConnectExternal.__listeners).toHaveLength(1)
  })

  it('a forbidden origin is refused and causes no storage write or network', async () => {
    const p = fakePort({
      origin: 'https://evil.example',
      url: 'https://evil.example/join',
      tab: { id: 1 },
    })
    for (const l of runtime.onConnectExternal.__listeners) l(p.port)
    p.send(HELLO())
    await new Promise((r) => setTimeout(r, 0))
    expect(p.posted.map((m) => m.payload)).toEqual([{ code: 'bad_origin' }])
    expect(await getJoinAttempt()).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('hello is network-free; exchange_token redeems via the STATIC client then checks in', async () => {
    const p = fakePort({ ...ZAB, tab: { id: 2 } })
    for (const l of runtime.onConnectExternal.__listeners) l(p.port)
    p.send(HELLO())
    await vi.waitFor(() => expect(p.types()).toEqual(['presence', 'challenge']))
    expect(p.posted[0]?.payload).toMatchObject({ state: 'unenrolled' })
    expect(fetchSpy).not.toHaveBeenCalled()

    p.send(
      w('exchange_token', {
        exchange_token: 'xt-1',
        expires_at: 'x',
        challenge_nonce: p.posted[1]?.nonce,
      }),
    )
    await vi.waitFor(() => expect(p.types()).toEqual(['presence', 'challenge', 'ack', 'result']))
    expect(p.posted[3]?.payload).toMatchObject({ status: 'success', connected_org_id: 'o' })
    await vi.waitFor(() =>
      expect(fetchSpy.mock.calls.map((c) => String(c[0]))).toEqual([
        `${BASE}/functions/v1/join`,
        `${BASE}/functions/v1/checkin`,
      ]),
    )
  })
})
