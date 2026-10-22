// Settings application vs acknowledgment ordering (pre-pilot gate, #104).
//
// The applied revision is what the NEXT check-in reports as acknowledged, so it
// may be persisted only AFTER every settings write has succeeded. A worker that
// dies, or a storage write that fails, at ANY point of an apply must leave the
// old applied revision in place: the next check-in then reports the old
// revision (never the unapplied one) and re-applies, and only after that apply
// completes does the new revision get acknowledged. The user's original
// preference snapshot must survive the retry, so a later revoke still restores it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runCheckin } from '../src/enterprise/teams-service'
import {
  getManagedState,
  getPreManagedPrefs,
  setEnrollment,
  setManagedState,
  TEAMS_MANAGED_KEY,
  TEAMS_PRE_MANAGED_KEY,
} from '../src/shared/teams-storage'
import { getPrefs, setPrefs } from '../src/shared/storage'
import type { CheckinRequest, CheckinResponse } from '../src/shared/teams-contract'
import type { CheckinCallResult } from '../src/enterprise/teams-client'

const BASE = 'http://127.0.0.1:54321'
const active = (revision: number, show: boolean): CheckinResponse => ({
  revoked: false,
  org_id: 'org_1',
  target_settings_revision: revision,
  settings: { show_indicator: show },
})

/** A backend double that always serves `response`, recording every request. */
function backend(response: () => CheckinCallResult) {
  const requests: CheckinRequest[] = []
  return {
    requests,
    loadClient: async () => ({
      enroll: vi.fn(),
      checkin: async (_b: string, _a: string, req: CheckinRequest) => {
        requests.push(req)
        return response()
      },
    }),
  }
}

/** Make the NEXT chrome.storage.local.set that writes `key` fail once (a failed
 *  write, or the worker dying at exactly that point: nothing after it runs). */
function failNextWriteOf(key: string): { writes: string[] } {
  const realSet = chrome.storage.local.set.bind(chrome.storage.local)
  const writes: string[] = []
  let armed = true
  vi.spyOn(chrome.storage.local, 'set').mockImplementation(async (items: Record<string, unknown>) => {
    writes.push(...Object.keys(items))
    if (armed && key in items) {
      armed = false
      throw new Error('storage write failed')
    }
    return realSet(items)
  })
  return { writes }
}

/** Record the order of storage writes during one successful apply. */
function recordWrites(): string[] {
  const realSet = chrome.storage.local.set.bind(chrome.storage.local)
  const writes: string[] = []
  vi.spyOn(chrome.storage.local, 'set').mockImplementation(async (items: Record<string, unknown>) => {
    writes.push(...Object.keys(items))
    return realSet(items)
  })
  return writes
}

beforeEach(async () => {
  vi.stubEnv('VITE_TEAMS_BASE_URL', BASE)
  vi.stubEnv('VITE_TEAMS_ANON_KEY', 'anon-key')
  await setEnrollment({ install_id: 'inst_1', install_credential: 'cred_1', org_id: 'org_1', org_name: 'Harbor', base_url: BASE })
  await setPrefs({ showIndicator: true }) // the user's own value
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('the applied revision is persisted only after the settings writes', () => {
  it('on a successful apply, the acknowledgment record is the LAST write', async () => {
    const writes = recordWrites()
    const be = backend(() => ({ ok: true, response: active(1, false) }))
    expect(await runCheckin({ loadClient: be.loadClient })).toBe('apply')
    const relevant = writes.filter((k) => [TEAMS_PRE_MANAGED_KEY, 'prefs', TEAMS_MANAGED_KEY].includes(k))
    expect(relevant).toEqual([TEAMS_PRE_MANAGED_KEY, 'prefs', TEAMS_MANAGED_KEY])
    expect((await getPrefs()).showIndicator).toBe(false)
    expect((await getManagedState())?.appliedSettingsRevision).toBe(1)
  })
})

// The three points an apply can be cut short, on a first apply (nothing applied
// yet) and on a later revision bump (revision 1 applied, revision 2 arrives).
const CUT_POINTS: { name: string; key: string }[] = [
  { name: 'before the snapshot is written', key: TEAMS_PRE_MANAGED_KEY },
  { name: 'before the setting itself is written', key: 'prefs' },
  { name: 'after the setting, before the acknowledgment record', key: TEAMS_MANAGED_KEY },
]

describe.each(CUT_POINTS)('interrupted $name', ({ key }) => {
  it('first apply: the unapplied revision is never reported; the retry applies it, then acknowledges it', async () => {
    const be = backend(() => ({ ok: true, response: active(1, false) }))

    failNextWriteOf(key)
    await expect(runCheckin({ loadClient: be.loadClient })).rejects.toThrow()
    // Nothing is recorded as applied, so nothing can be acknowledged.
    expect(await getManagedState()).toBeNull()
    vi.restoreAllMocks()

    // The worker restarts; the next check-in must NOT claim revision 1 …
    expect(await runCheckin({ loadClient: be.loadClient })).toBe('apply')
    expect(be.requests[1]?.applied_settings_revision).toBeUndefined()
    // … it re-applies, and only now is revision 1 recorded …
    expect((await getPrefs()).showIndicator).toBe(false)
    expect((await getManagedState())?.appliedSettingsRevision).toBe(1)
    // … and the following check-in acknowledges it.
    expect(await runCheckin({ loadClient: be.loadClient })).toBe('noop')
    expect(be.requests[2]?.applied_settings_revision).toBe(1)
    // The user's ORIGINAL value survived the interrupted attempt (a revoke restores it).
    expect(await getPreManagedPrefs()).toEqual({ showIndicator: true })
  })

  it('revision bump: the old revision stays acknowledged until the new one is fully applied', async () => {
    // Revision 1 applied normally first.
    let served = active(1, false)
    const be = backend(() => ({ ok: true, response: served }))
    expect(await runCheckin({ loadClient: be.loadClient })).toBe('apply')
    served = active(2, true)

    failNextWriteOf(key)
    await expect(runCheckin({ loadClient: be.loadClient })).rejects.toThrow()
    expect((await getManagedState())?.appliedSettingsRevision).toBe(1)
    vi.restoreAllMocks()

    expect(await runCheckin({ loadClient: be.loadClient })).toBe('apply')
    expect(be.requests.at(-1)?.applied_settings_revision).toBe(1) // never 2 before it is applied
    expect((await getPrefs()).showIndicator).toBe(true)
    expect((await getManagedState())?.appliedSettingsRevision).toBe(2)
    expect(await runCheckin({ loadClient: be.loadClient })).toBe('noop')
    expect(be.requests.at(-1)?.applied_settings_revision).toBe(2)
    expect(await getPreManagedPrefs()).toEqual({ showIndicator: true }) // still the user's own value
  })
})

describe('a failed check-in is retried by the worker, not acknowledged', () => {
  it('a failed apply surfaces as an error (the worker schedules its backoff retry) and records nothing', async () => {
    await setManagedState({ appliedSettingsRevision: 3, orgId: 'org_1' })
    const be = backend(() => ({ ok: true, response: active(4, false) }))
    failNextWriteOf('prefs')
    await expect(runCheckin({ loadClient: be.loadClient })).rejects.toThrow('storage write failed')
    expect((await getManagedState())?.appliedSettingsRevision).toBe(3)
    expect((await getPrefs()).showIndicator).toBe(true)
  })
})
