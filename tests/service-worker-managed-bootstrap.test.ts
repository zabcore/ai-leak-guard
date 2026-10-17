// Teams Lite (deployment m1) — the service worker's managed-bootstrap WIRING.
// Imports the real worker module (its listeners register on the test shims) and
// drives startup / install / managed-policy-change with a global fetch spy, so
// this exercises the statically-injected provision client end to end — minus a
// live backend.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { getEnrollment, setEnrollment, setRevokeBlock } from '../src/shared/teams-storage'

type Listener = (...args: unknown[]) => unknown
const chromeShim = (
  globalThis as unknown as {
    chrome: {
      storage: {
        managed: { __set: (v: Record<string, unknown> | null) => void }
        onChanged: { __listeners: Listener[] }
      }
      runtime: { onStartup: { __listeners: Listener[] }; onInstalled: { __listeners: Listener[] } }
    }
  }
).chrome

const BASE = 'http://127.0.0.1:54321'
let fetchSpy: ReturnType<typeof vi.fn>

function urls(): string[] {
  return fetchSpy.mock.calls.map((c) => String(c[0]))
}

async function fire(listeners: Listener[], ...args: unknown[]): Promise<void> {
  await Promise.all(listeners.map((l) => l(...args)))
}
const startup = () => fire(chromeShim.runtime.onStartup.__listeners)
const install = () => fire(chromeShim.runtime.onInstalled.__listeners, { reason: 'update' })
const policyChanged = () => fire(chromeShim.storage.onChanged.__listeners, {}, 'managed')

beforeAll(async () => {
  await import('../src/background/service-worker')
})

beforeEach(() => {
  vi.stubEnv('VITE_TEAMS_BASE_URL', BASE)
  vi.stubEnv('VITE_TEAMS_ANON_KEY', 'anon')
  fetchSpy = vi.fn(async (url: string) => {
    const body = url.endsWith('/provision')
      ? { install_id: 'i1', install_credential: 'c1', org_id: 'org_1', org_name: 'Harbor' }
      : { revoked: false, org_id: 'org_1', target_settings_revision: 0, settings: {} }
    return { ok: true, status: 200, json: async () => body }
  })
  ;(globalThis as { fetch: unknown }).fetch = fetchSpy
})
afterEach(() => {
  vi.unstubAllEnvs()
  delete (globalThis as { fetch?: unknown }).fetch
})

describe('service worker — managed bootstrap wiring', () => {
  it('registers a storage.onChanged listener', () => {
    expect(chromeShim.storage.onChanged.__listeners.length).toBeGreaterThan(0)
  })

  it('no policy: startup, install and a policy-change event are ALL network-silent', async () => {
    await startup()
    await install()
    await policyChanged()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('a non-managed storage change never triggers the bootstrap', async () => {
    chromeShim.storage.managed.__set({ deploymentToken: 'tok-A' })
    await fire(chromeShim.storage.onChanged.__listeners, {}, 'local')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('policy arrives → provisions via the STATIC client, then runs the first check-in', async () => {
    chromeShim.storage.managed.__set({ deploymentToken: 'tok-A' })
    await policyChanged()
    expect(urls()).toEqual([`${BASE}/functions/v1/provision`, `${BASE}/functions/v1/checkin`])
    const body = JSON.parse((fetchSpy.mock.calls[0]?.[1] as RequestInit).body as string)
    expect(Object.keys(body).sort()).toEqual(['attempt_id', 'deployment_token', 'idempotency_key'])
    expect(urls()[0]).not.toContain('tok-A') // token only in the body, never the URL
    expect(await getEnrollment()).toMatchObject({ install_id: 'i1', org_id: 'org_1' })
  })

  it('policy on startup → provisions before the startup check-in', async () => {
    chromeShim.storage.managed.__set({ deploymentToken: 'tok-A' })
    await startup()
    expect(urls()).toEqual([`${BASE}/functions/v1/provision`, `${BASE}/functions/v1/checkin`])
  })

  it('autoEnroll:false → no provision', async () => {
    chromeShim.storage.managed.__set({ deploymentToken: 'tok-A', autoEnroll: false })
    await policyChanged()
    await install()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('already enrolled + rotated token → no provision (check-in only)', async () => {
    await setEnrollment({
      install_id: 'inst_1',
      install_credential: 'cred_1',
      org_id: 'org_1',
      org_name: 'Harbor',
      base_url: BASE,
    })
    chromeShim.storage.managed.__set({ deploymentToken: 'tok-OTHER' })
    await startup()
    expect(urls()).toEqual([`${BASE}/functions/v1/checkin`])
  })

  it('revoke-blocked + rotated token → network-silent', async () => {
    await setRevokeBlock()
    chromeShim.storage.managed.__set({ deploymentToken: 'tok-ROTATED' })
    await policyChanged()
    await startup()
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
