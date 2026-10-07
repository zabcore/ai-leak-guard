// Teams Lite — B1: lost-/join-response INTEGRATION test.
//
// The REAL extension join path — the bridge port server, prepareChallenge /
// exchangeJoin / runJoin, the real teams-client `join()` over HTTP and the
// persisted attempt in chrome.storage — against a REAL backend (the backend
// repo's edge handlers + Postgres with its migrations, or the full local
// Supabase stack), started by zabcore/teams-onboarding-backend
// tests/it/join-fixture.mjs. Run it with `npm run test:it:join` (needs the
// backend checkout; see scripts/run-join-it.mjs). Without the fixture's env the
// integration cases are skipped; the fault-switch guard below always runs.
//
// The fault (a /join response dropped AFTER the backend committed) is injected
// HERE, by wrapping globalThis.fetch for this test process only. Nothing in
// src/ knows about it: there is no fault switch in any build.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join as pathJoin, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BRIDGE_NS,
  JOIN_PORT_NAME,
  createJoinPortServer,
  uuidv7,
  type JoinPort,
} from '../../src/background/teams-join-port'
import {
  exchangeJoin,
  hasPendingJoin,
  joinPresenceState,
  prepareChallenge,
  runJoin,
} from '../../src/enterprise/teams-join'
import { getJoinAttempt, getJoinResult } from '../../src/shared/teams-join-attempt'
import { getEnrollment } from '../../src/shared/teams-storage'

const BASE_URL = process.env.TEAMS_IT_BASE_URL ?? ''
const ANON_KEY = process.env.TEAMS_IT_ANON_KEY ?? ''
const FIXTURE = process.env.TEAMS_IT_FIXTURE_URL ?? ''
const ISO_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/

const realFetch = globalThis.fetch

type BackendState = {
  invitation_status: string | null
  installs: Array<{ id: string; created_via: string }>
  exchanges: Array<{ consumed: boolean }>
  attempts: Array<{ status: string; install_id: string | null }>
  org_installs: number
}

async function fixture<T>(path: string, body: Record<string, unknown> = {}): Promise<T> {
  const r = await realFetch(`${FIXTURE}/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = (await r.json()) as T
  if (!r.ok) throw new Error(`fixture ${path} -> ${r.status} ${JSON.stringify(json)}`)
  return json
}
const state = (invitation_ref: string) => fixture<BackendState>('state', { invitation_ref })
async function joinInit(invitation_ref: string, attempt_challenge: string) {
  const r = await fixture<{ status: number; body: Record<string, unknown> }>('join-init', {
    invitation_ref,
    attempt_challenge,
  })
  expect(r.status, JSON.stringify(r.body)).toBe(200)
  // Contract v1.1.2: the page forwards expires_at verbatim; it must be ISO 8601 UTC.
  expect(r.body.expires_at).toMatch(ISO_Z)
  return { exchange_token: String(r.body.exchange_token), expires_at: String(r.body.expires_at) }
}

/**
 * Test-only network fault: every /functions/v1/join request goes to the real
 * backend; for the first `drops` of them the full response is received (so the
 * backend has committed) and then DISCARDED, and the caller sees a network
 * failure. Records every outgoing request for the assertions.
 */
function installDropAfterCommit(drops: number) {
  const joinBodies: string[] = []
  const urls: string[] = []
  const dropped: Array<Record<string, unknown>> = []
  let left = drops
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    urls.push(url)
    const res = await realFetch(input, init)
    if (!url.endsWith('/functions/v1/join')) return res
    joinBodies.push(String(init?.body ?? ''))
    if (left > 0) {
      left--
      expect(res.status).toBe(200) // the backend committed this join
      dropped.push((await res.json()) as Record<string, unknown>)
      throw new TypeError('Failed to fetch') // …and the extension never sees it
    }
    return res
  }) as typeof fetch
  return { joinBodies, urls, dropped }
}

type Posted = { type: string; nonce: string; payload: Record<string, unknown> }
function bridgePage(server: ReturnType<typeof createJoinPortServer>) {
  const posted: Posted[] = []
  let onMsg: ((m: unknown) => void) | undefined
  const port: JoinPort = {
    name: JOIN_PORT_NAME,
    sender: { origin: 'https://zabcore.com', url: 'https://zabcore.com/join', tab: { id: 11 } },
    postMessage: (m) => posted.push(m as Posted),
    disconnect: () => {},
    onMessage: { addListener: (f) => (onMsg = f) },
    onDisconnect: { addListener: () => {} },
  }
  server.onConnect(port)
  const send = (type: string, payload: Record<string, unknown>) =>
    onMsg?.({ ns: BRIDGE_NS, v: 1, type, nonce: uuidv7(), ts: new Date().toISOString(), payload })
  async function next(type: string, from: number): Promise<Posted> {
    for (let i = 0; i < 400; i++) {
      const hit = posted.slice(from).find((p) => p.type === type)
      if (hit) return hit
      await new Promise((r) => setTimeout(r, 25))
    }
    throw new Error(`no ${type} after ${JSON.stringify(posted.map((p) => p.type))}`)
  }
  return { posted, send, next }
}

/** The service-worker wiring (src/background/service-worker.ts), minus checkin. */
const portServer = () =>
  createJoinPortServer({
    presence: async () => ({ ext_version: 'it', state: await joinPresenceState() }),
    hello: (ref, nonce) => prepareChallenge(ref, nonce),
    exchange: (token, nonce) => exchangeJoin(token, nonce),
  })

async function storageDump(): Promise<string> {
  return JSON.stringify(await chrome.storage.local.get(null))
}

describe.skipIf(FIXTURE === '')('B1: /join response lost AFTER the backend committed', () => {
  const logged: string[] = []
  beforeEach(() => {
    vi.stubEnv('VITE_TEAMS_BASE_URL', BASE_URL)
    vi.stubEnv('VITE_TEAMS_ANON_KEY', ANON_KEY)
    logged.length = 0
    for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
        logged.push(a.map(String).join(' '))
      })
    }
  })
  afterEach(() => {
    globalThis.fetch = realFetch
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('bridge path: the page re-sends its token on the same challenge → same attempt, same install, consumed once', async () => {
    const { invitation_ref } = await fixture<{ invitation_ref: string }>('invite')
    const before = await state(invitation_ref)
    const page = bridgePage(portServer())

    page.send('hello', { invitation_ref, locale: 'en' })
    const challenge = await page.next('challenge', 0)
    const attempt = await getJoinAttempt()
    expect(attempt).not.toBeNull()
    const secret = attempt!.attemptSecret
    const { exchange_token, expires_at } = await joinInit(
      invitation_ref,
      String(challenge.payload.attempt_challenge),
    )

    const net = installDropAfterCommit(1)
    let from = page.posted.length
    page.send('exchange_token', { exchange_token, expires_at, challenge_nonce: challenge.nonce })
    const lost = await page.next('result', from)
    expect(lost.payload).toEqual({ status: 'failed', error_code: 'backend_unavailable' })

    // The backend committed exactly one install + consumed the exchange; the
    // extension holds no credential and keeps the SAME attempt (with its token).
    const committed = await state(invitation_ref)
    expect(committed.installs).toHaveLength(1)
    expect(committed.installs[0]!.id).toBe(net.dropped[0]!.install_id)
    expect(committed.invitation_status).toBe('redeemed')
    expect(committed.exchanges).toEqual([{ consumed: true }])
    expect(await getEnrollment()).toBeNull()
    const kept = await getJoinAttempt()
    expect(kept?.attemptSecret).toBe(secret)
    expect(kept?.challenge).toBe(attempt!.challenge)
    expect(kept?.exchangeToken).toBe(exchange_token)

    // Recovery: the page re-sends the same token on the same challenge.
    from = page.posted.length
    page.send('exchange_token', { exchange_token, expires_at, challenge_nonce: challenge.nonce })
    const ok = await page.next('result', from)
    expect(ok.payload).toMatchObject({
      status: 'success',
      connected_invitation_ref: invitation_ref,
      connected_attempt_challenge: challenge.payload.attempt_challenge,
    })

    // Same attempt on the wire (identical secret, idempotency key and token).
    expect(net.joinBodies).toHaveLength(2)
    expect(net.joinBodies[1]).toBe(net.joinBodies[0])
    // Same install: the credential the extension stored is the one committed first.
    expect((await getEnrollment())?.install_id).toBe(net.dropped[0]!.install_id)
    // #88: the page learns which installation this join created.
    expect(ok.payload.connected_install_id).toBe(net.dropped[0]!.install_id)
    // No duplicate consumption.
    const after = await state(invitation_ref)
    expect(after.installs).toEqual(committed.installs)
    expect(after.attempts).toEqual([{ status: 'completed', install_id: committed.installs[0]!.id }])
    expect(after.exchanges).toEqual([{ consumed: true }])
    expect(after.org_installs).toBe(before.org_installs + 1)

    // No attempt-secret exposure: never posted to the page, never logged, never
    // in a URL, and gone from storage once the join settled.
    expect(JSON.stringify(page.posted)).not.toContain(secret)
    expect(logged.join('\n')).not.toContain(secret)
    expect(net.urls.join('\n')).not.toContain(secret)
    expect(await getJoinAttempt()).toBeNull()
    expect(await storageDump()).not.toContain(secret)
  })

  it('worker-restart path: startup recovery (hasPendingJoin → runJoin) re-sends the persisted attempt', async () => {
    const { invitation_ref } = await fixture<{ invitation_ref: string }>('invite')
    const before = await state(invitation_ref)
    const nonce = uuidv7()
    const hello = await prepareChallenge(invitation_ref, nonce)
    if (hello.kind !== 'challenge') throw new Error(JSON.stringify(hello))
    const secret = (await getJoinAttempt())!.attemptSecret
    const { exchange_token } = await joinInit(invitation_ref, hello.attempt_challenge)

    const net = installDropAfterCommit(1)
    const lost = await exchangeJoin(exchange_token, nonce)
    expect(lost.result).toEqual({ status: 'failed', error_code: 'backend_unavailable' })
    expect(await hasPendingJoin()).toBe(true)
    expect((await state(invitation_ref)).installs).toHaveLength(1)

    // The service worker's startup recovery: no token offered, the persisted one is used.
    expect(await runJoin(undefined)).toBe('enrolled')
    expect(net.joinBodies).toHaveLength(2)
    expect(net.joinBodies[1]).toBe(net.joinBodies[0])
    expect((await getEnrollment())?.install_id).toBe(net.dropped[0]!.install_id)

    // A late page replay on the same challenge gets the stored result, no /join.
    const replay = await exchangeJoin(exchange_token, nonce)
    expect(replay).toMatchObject({ result: { status: 'success' }, enrolledNow: false })
    expect(net.joinBodies).toHaveLength(2)
    expect((await getJoinResult())?.result).toEqual(replay.result)

    const after = await state(invitation_ref)
    expect(after.installs).toHaveLength(1)
    expect(after.installs[0]!.id).toBe(net.dropped[0]!.install_id)
    expect(after.attempts).toHaveLength(1)
    expect(after.exchanges).toEqual([{ consumed: true }])
    expect(after.org_installs).toBe(before.org_installs + 1)
    expect(logged.join('\n')).not.toContain(secret)
    expect(await storageDump()).not.toContain(secret)
  })
})

// Always runs (CI included): the fault lives only in this test file. No shipped
// source references the integration env or carries a fault/drop hook.
describe('B1 guard: no production-accessible fault switch', () => {
  it('src/ has no reference to the integration fixture or a response-drop hook', () => {
    const files: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = pathJoin(dir, name)
        if (statSync(p).isDirectory()) walk(p)
        else if (/\.(ts|tsx|js|mjs|json)$/.test(name)) files.push(p)
      }
    }
    walk(resolve(__dirname, '../../src'))
    expect(files.length).toBeGreaterThan(10)
    const hits = files.filter((f) =>
      /TEAMS_IT_|join-fixture|dropAfterCommit|DropAfterCommit|faultInject|\bFAULT_/.test(
        readFileSync(f, 'utf8'),
      ),
    )
    expect(hits).toEqual([])
  })
})
