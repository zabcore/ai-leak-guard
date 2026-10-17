// F-TD-1 — the service worker's install re-check WIRING. A force-install's
// `onInstalled` can read `chrome.storage.managed` before Chrome delivers the
// policy; a `no-policy` skip at install must schedule a short, bounded re-check
// so the browser still enrolls if the policy-change event is missed. Imports the
// real worker with a `chrome.alarms` shim installed first (this file only), and
// drives install / startup / the re-check alarm with a global fetch spy.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { BOOTSTRAP_RECHECK_MAX } from '../src/background/teams-bootstrap-plan'
import { getEnrollment, setRevokeBlock } from '../src/shared/teams-storage'
import { getLastBootstrapAttempt } from '../src/shared/teams-diag'

type Listener = (...args: unknown[]) => unknown
const chromeShim = (
  globalThis as unknown as {
    chrome: {
      storage: { managed: { __set: (v: Record<string, unknown> | null) => void } }
      runtime: { onStartup: { __listeners: Listener[] }; onInstalled: { __listeners: Listener[] } }
      alarms?: unknown
    }
  }
).chrome

const RECHECK = 'alg-teams-bootstrap-recheck'
const alarms = new Map<string, { delayInMinutes?: number }>()
const alarmListeners: Listener[] = []

const BASE = 'http://127.0.0.1:54321'
let fetchSpy: ReturnType<typeof vi.fn>
const urls = () => fetchSpy.mock.calls.map((c) => String(c[0]))

async function fire(listeners: Listener[], ...args: unknown[]): Promise<void> {
  await Promise.all(listeners.map((l) => l(...args)))
}
const install = () => fire(chromeShim.runtime.onInstalled.__listeners, { reason: 'install' })
const startup = () => fire(chromeShim.runtime.onStartup.__listeners)
const recheckAlarm = () => fire(alarmListeners, { name: RECHECK })

beforeAll(async () => {
  chromeShim.alarms = {
    create: (name: string, info: { delayInMinutes?: number }) => {
      alarms.set(name, info)
    },
    get: async (name: string) =>
      alarms.has(name) ? { name, scheduledTime: Date.now() + 60_000 } : undefined,
    clear: async (name: string) => alarms.delete(name),
    onAlarm: { addListener: (fn: Listener) => alarmListeners.push(fn) },
  }
  await import('../src/background/service-worker')
})
afterAll(() => {
  delete chromeShim.alarms
})

beforeEach(() => {
  alarms.clear()
  chromeShim.storage.managed.__set(null)
  vi.stubEnv('VITE_TEAMS_BASE_URL', BASE)
  vi.stubEnv('VITE_TEAMS_ANON_KEY', 'anon')
  fetchSpy = vi.fn(async (url: string) => {
    const body = url.endsWith('/provision')
      ? { install_id: 'i1', install_credential: 'c1', org_id: 'org_1', org_name: 'Harbor' }
      : {
          revoked: false,
          org_id: 'org_1',
          target_settings_revision: 1,
          settings: { show_indicator: true },
        }
    return { ok: true, status: 200, json: async () => body }
  })
  ;(globalThis as { fetch: unknown }).fetch = fetchSpy
})
afterEach(() => {
  vi.unstubAllEnvs()
  delete (globalThis as { fetch?: unknown }).fetch
})

describe('service worker — install re-check (F-TD-1)', () => {
  it('force-install race: install reads no policy, the policy arrives without an event → the re-check enrolls', async () => {
    await install()
    expect(alarms.get(RECHECK)).toEqual({ delayInMinutes: 1 })
    expect(fetchSpy).not.toHaveBeenCalled()

    chromeShim.storage.managed.__set({ deploymentToken: 'tok-A', autoEnroll: true }) // no onChanged
    await recheckAlarm()

    // provision once, then the post-provision check-in (+ its one-time ack, since
    // the fake server returns valid settings that get applied)
    expect(urls()).toEqual([
      `${BASE}/functions/v1/provision`,
      `${BASE}/functions/v1/checkin`,
      `${BASE}/functions/v1/checkin`,
    ])
    expect(await getEnrollment()).toMatchObject({ install_id: 'i1' })
    expect(alarms.has(RECHECK)).toBe(false) // done: no further re-check
    expect(await getLastBootstrapAttempt()).toMatchObject({
      trigger: 'recheck',
      result: 'enrolled',
    })
  })

  it('no policy ever (a Free user): bounded re-checks, all network-silent, then it stops', async () => {
    await install()
    for (let i = 0; i < BOOTSTRAP_RECHECK_MAX; i++) {
      expect(alarms.has(RECHECK)).toBe(true)
      await recheckAlarm()
    }
    expect(alarms.has(RECHECK)).toBe(false)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('policy already present at install → provisions directly, no re-check', async () => {
    chromeShim.storage.managed.__set({ deploymentToken: 'tok-A' })
    await install()
    expect(urls()[0]).toBe(`${BASE}/functions/v1/provision`)
    expect(alarms.has(RECHECK)).toBe(false)
  })

  it('revoke-blocked: no re-check, no request — and the popup-facing record says why', async () => {
    await setRevokeBlock()
    chromeShim.storage.managed.__set({ deploymentToken: 'tok-ROTATED' })
    await install()
    expect(alarms.has(RECHECK)).toBe(false)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(await getLastBootstrapAttempt()).toMatchObject({
      trigger: 'install',
      action: 'skip',
      result: 'revoked-block',
      tokenPresent: true,
    })
  })

  it('startup with no policy does not schedule the install re-check', async () => {
    await startup()
    expect(alarms.has(RECHECK)).toBe(false)
  })
})
