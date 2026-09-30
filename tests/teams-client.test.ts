// Teams Lite (#78) — the HTTP client: status → result mapping, auth headers.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { enroll, checkin } from '../src/enterprise/teams-client'

function res(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response
}

afterEach(() => {
  vi.restoreAllMocks()
  delete (globalThis as { fetch?: unknown }).fetch
})

const BASE = 'http://127.0.0.1:54321'
const ANON = 'anon-key-123'

describe('enroll', () => {
  it('2xx + valid body → ok with the credential', async () => {
    const fetchMock = vi.fn(async () =>
      res(200, { install_id: 'i', install_credential: 'c', org_id: 'o', org_name: 'Harbor' }),
    )
    ;(globalThis as { fetch: unknown }).fetch = fetchMock
    const r = await enroll(BASE, ANON, { code: 'ABC', label: 'Front desk' })
    expect(r).toEqual({
      ok: true,
      data: { install_id: 'i', install_credential: 'c', org_id: 'o', org_name: 'Harbor' },
    })
    // POSTs to the enroll function with the anon key as apikey + Bearer.
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${BASE}/functions/v1/enroll`)
    const headers = init.headers as Record<string, string>
    expect(headers.apikey).toBe(ANON)
    expect(headers.Authorization).toBe(`Bearer ${ANON}`)
    expect(JSON.parse(init.body as string)).toEqual({ code: 'ABC', label: 'Front desk' })
  })

  it('maps error status codes to error codes', async () => {
    const cases: Array<[number, unknown, string]> = [
      [404, { error: 'invalid_code' }, 'invalid_code'],
      [409, { error: 'already_used' }, 'already_used'],
      [410, { error: 'expired' }, 'expired'],
      [410, { error: 'revoked' }, 'revoked'],
      [500, {}, 'network'],
    ]
    for (const [status, body, code] of cases) {
      ;(globalThis as { fetch: unknown }).fetch = vi.fn(async () => res(status, body))
      const r = await enroll(BASE, ANON, { code: 'x', label: 'y' })
      expect(r).toEqual({ ok: false, code })
    }
  })

  it('a thrown fetch (offline) → network', async () => {
    ;(globalThis as { fetch: unknown }).fetch = vi.fn(async () => {
      throw new Error('offline')
    })
    expect(await enroll(BASE, ANON, { code: 'x', label: 'y' })).toEqual({
      ok: false,
      code: 'network',
    })
  })

  it('2xx + malformed body → network (never a spurious success)', async () => {
    ;(globalThis as { fetch: unknown }).fetch = vi.fn(async () => res(200, { nope: true }))
    expect(await enroll(BASE, ANON, { code: 'x', label: 'y' })).toEqual({
      ok: false,
      code: 'network',
    })
  })
})

describe('checkin', () => {
  it('2xx active → ok + response', async () => {
    const body = {
      revoked: false,
      org_id: 'o',
      target_settings_revision: 4,
      settings: { show_indicator: false },
    }
    ;(globalThis as { fetch: unknown }).fetch = vi.fn(async () => res(200, body))
    const r = await checkin(BASE, ANON, { install_id: 'i', credential: 'c' })
    expect(r).toEqual({ ok: true, response: body })
  })

  it('2xx revoked → ok + {revoked:true}', async () => {
    ;(globalThis as { fetch: unknown }).fetch = vi.fn(async () => res(200, { revoked: true }))
    const r = await checkin(BASE, ANON, { install_id: 'i', credential: 'c' })
    expect(r).toEqual({ ok: true, response: { revoked: true } })
  })

  it('non-2xx → not ok (→ RETAIN in the state machine)', async () => {
    ;(globalThis as { fetch: unknown }).fetch = vi.fn(async () => res(503, {}))
    expect(await checkin(BASE, ANON, { install_id: 'i', credential: 'c' })).toEqual({ ok: false })
  })

  it('thrown fetch → not ok', async () => {
    ;(globalThis as { fetch: unknown }).fetch = vi.fn(async () => {
      throw new Error('offline')
    })
    expect(await checkin(BASE, ANON, { install_id: 'i', credential: 'c' })).toEqual({ ok: false })
  })

  it('2xx malformed → not ok', async () => {
    ;(globalThis as { fetch: unknown }).fetch = vi.fn(async () => res(200, { garbage: 1 }))
    expect(await checkin(BASE, ANON, { install_id: 'i', credential: 'c' })).toEqual({ ok: false })
  })
})
