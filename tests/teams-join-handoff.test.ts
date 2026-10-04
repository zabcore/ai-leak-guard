// Teams Lite (deployment m1) — website ⇄ extension join handoff (Contract A §4c).
// Proves the origin allowlist, and that the attempt SECRET is never routed to the
// website: every response the page can observe is scanned for it, while the
// injected backend client is shown to receive it.

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  JOIN_HANDOFF_ORIGINS,
  handleJoinHandoff,
  type JoinHandoffResponse,
} from '../src/background/teams-join-handoff'
import { beginJoin, runJoin } from '../src/enterprise/teams-join'
import type { JoinRequest } from '../src/enterprise/teams-client'
import { getEnrollment } from '../src/shared/teams-storage'
import { getJoinAttempt } from '../src/shared/teams-join-attempt'

const BASE = 'http://127.0.0.1:54321'
const ZAB = { origin: 'https://zabcore.com', url: 'https://zabcore.com/join?i=abc' }

beforeEach(() => {
  vi.stubEnv('VITE_TEAMS_BASE_URL', BASE)
  vi.stubEnv('VITE_TEAMS_ANON_KEY', 'anon')
})
afterEach(() => {
  vi.unstubAllEnvs()
  delete (globalThis as { fetch?: unknown }).fetch
})

describe('handleJoinHandoff', () => {
  const never = {
    begin: vi.fn(async () => ({ ok: true as const, challenge: 'c' })),
    complete: vi.fn(async () => 'enrolled' as const),
  }

  it('ignores messages that are not join handoff messages', async () => {
    expect(await handleJoinHandoff({ type: 'alg-event-append' }, ZAB, never)).toBeNull()
    expect(await handleJoinHandoff(null, ZAB, never)).toBeNull()
  })

  it.each([
    [{ origin: 'https://evil.example' }],
    [{ origin: 'https://zabcore.com.evil.example' }],
    [{ origin: 'http://zabcore.com' }],
    [{ url: 'https://evil.example/join' }],
    [{}],
  ])('refuses a non-allowlisted sender %j (no begin, no complete)', async (sender) => {
    const deps = { begin: vi.fn(), complete: vi.fn() }
    expect(await handleJoinHandoff({ type: 'alg-join-begin' }, sender, deps)).toEqual({
      ok: false,
      error: 'forbidden',
    })
    expect(
      await handleJoinHandoff({ type: 'alg-join-complete', exchange_token: 't' }, sender, deps),
    ).toEqual({
      ok: false,
      error: 'forbidden',
    })
    expect(deps.begin).not.toHaveBeenCalled()
    expect(deps.complete).not.toHaveBeenCalled()
  })

  it('rejects a missing / non-string exchange token', async () => {
    const deps = { begin: vi.fn(), complete: vi.fn() }
    for (const exchange_token of [undefined, 42, '', 'x'.repeat(5000)]) {
      expect(
        await handleJoinHandoff({ type: 'alg-join-complete', exchange_token }, ZAB, deps),
      ).toEqual({
        ok: false,
        error: 'bad_request',
      })
    }
    expect(deps.complete).not.toHaveBeenCalled()
  })

  it('the allowlist matches the manifest externally_connectable entry', () => {
    const manifest = JSON.parse(readFileSync(resolve('manifest.json'), 'utf8')) as {
      externally_connectable?: { matches?: string[]; ids?: string[] }
    }
    expect(manifest.externally_connectable).toEqual({ matches: ['https://zabcore.com/*'] })
    expect(JOIN_HANDOFF_ORIGINS).toEqual(['https://zabcore.com'])
  })
})

describe('the attempt secret never reaches the website', () => {
  it('begin → challenge to page; complete → secret to backend only; page sees no secret', async () => {
    const backendCalls: JoinRequest[] = []
    const loadClient = async () => ({
      join: async (_b: string, _a: string, req: JoinRequest) => {
        backendCalls.push(req)
        return {
          ok: true as const,
          data: {
            install_id: 'i1',
            install_credential: 'CRED-SECRET',
            org_id: 'o',
            org_name: 'H',
            role: 'staff' as const,
          },
        }
      },
    })
    const deps = { begin: () => beginJoin(), complete: (t: string) => runJoin(t, { loadClient }) }
    const seenByPage: JoinHandoffResponse[] = []

    const begun = await handleJoinHandoff({ type: 'alg-join-begin' }, ZAB, deps)
    seenByPage.push(begun as JoinHandoffResponse)
    const secret = (await getJoinAttempt())?.attemptSecret as string
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(begun).toEqual({
      ok: true,
      challenge: createHash('sha256').update(secret).digest('base64url'),
      challenge_method: 'S256',
    })

    const done = await handleJoinHandoff(
      { type: 'alg-join-complete', exchange_token: 'xt-1' },
      ZAB,
      deps,
    )
    seenByPage.push(done as JoinHandoffResponse)
    expect(done).toEqual({ ok: true, outcome: 'enrolled' })

    // The backend got the secret; the page never saw it (nor the credential).
    expect(backendCalls).toHaveLength(1)
    expect(backendCalls[0]?.attempt_secret).toBe(secret)
    const pageView = JSON.stringify(seenByPage)
    expect(pageView).not.toContain(secret)
    expect(pageView).not.toContain('CRED-SECRET')
    expect(await getEnrollment()).toMatchObject({ install_credential: 'CRED-SECRET' })
  })
})

describe('service worker — onMessageExternal wiring', () => {
  type Listener = (m: unknown, s: unknown, r: (x: unknown) => void) => unknown
  const listeners = (
    globalThis as unknown as {
      chrome: { runtime: { onMessageExternal: { __listeners: Listener[] } } }
    }
  ).chrome.runtime.onMessageExternal.__listeners

  function send(message: unknown, sender: unknown): Promise<unknown> {
    return new Promise((resolveResponse) => {
      for (const l of listeners) l(message, sender, resolveResponse)
    })
  }

  let fetchSpy: ReturnType<typeof vi.fn>
  beforeAll(async () => {
    await import('../src/background/service-worker')
  })
  beforeEach(() => {
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

  it('a forbidden origin gets a refusal and causes no storage write or network', async () => {
    expect(await send({ type: 'alg-join-begin' }, { origin: 'https://evil.example' })).toEqual({
      ok: false,
      error: 'forbidden',
    })
    expect(await getJoinAttempt()).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('begin is network-free; complete redeems via the STATIC client then checks in', async () => {
    const begun = (await send({ type: 'alg-join-begin' }, ZAB)) as {
      ok: boolean
      challenge: string
    }
    expect(begun.ok).toBe(true)
    expect(fetchSpy).not.toHaveBeenCalled()

    expect(await send({ type: 'alg-join-complete', exchange_token: 'xt-1' }, ZAB)).toEqual({
      ok: true,
      outcome: 'enrolled',
    })
    expect(fetchSpy.mock.calls.map((c) => String(c[0]))).toEqual([
      `${BASE}/functions/v1/join`,
      `${BASE}/functions/v1/checkin`,
    ])
  })
})
