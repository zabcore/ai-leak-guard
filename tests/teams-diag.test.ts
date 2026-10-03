// Teams Lite (#78) — check-in diagnostics: runCheckin records a content-free
// attempt (trigger, result, revisions) to the ring buffer, and the buffer is
// bounded. No content, no credentials — labels, integers, and timestamps only.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runCheckin } from '../src/enterprise/teams-service'
import { readDiag, recordCheckinAttempt, TEAMS_DIAG_KEY } from '../src/shared/teams-diag'
import { setEnrollment, setManagedState } from '../src/shared/teams-storage'
import { setPrefs } from '../src/shared/storage'
import type { CheckinResponse } from '../src/shared/teams-contract'
import type { CheckinCallResult } from '../src/enterprise/teams-client'

const BASE = 'http://127.0.0.1:54321'

function mockLoad(checkin: CheckinCallResult) {
  return async () => ({
    enroll: async () => ({ ok: false as const, code: 'network' as const }),
    checkin: async () => checkin,
  })
}

const active = (revision: number, show: boolean): CheckinResponse => ({
  revoked: false,
  org_id: 'org_1',
  target_settings_revision: revision,
  settings: { show_indicator: show },
})

async function enroll(): Promise<void> {
  await setEnrollment({
    install_id: 'i',
    install_credential: 'c',
    org_id: 'org_1',
    org_name: 'Harbor',
    base_url: BASE,
  })
}

beforeEach(() => {
  vi.stubEnv('VITE_TEAMS_BASE_URL', BASE)
  vi.stubEnv('VITE_TEAMS_ANON_KEY', 'anon')
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('check-in diagnostics', () => {
  it('records trigger, result, and revisions on an apply', async () => {
    await enroll()
    await setPrefs({ showIndicator: true })
    await runCheckin({ loadClient: mockLoad({ ok: true, response: active(5, false) }), reason: 'alarm' })

    const { attempts } = await readDiag()
    expect(attempts).toHaveLength(1)
    expect(attempts[0]).toMatchObject({
      trigger: 'alarm',
      result: 'apply',
      reported: null, // nothing applied before this first check-in
      received: 5, // target from the server
      applied: 5, // applied after
    })
    expect(typeof attempts[0]?.at).toBe('string')
  })

  it('records a retain with no revision change when the server is unreachable', async () => {
    await enroll()
    await setManagedState({ appliedSettingsRevision: 3, orgId: 'org_1' })
    await runCheckin({ loadClient: mockLoad({ ok: false }), reason: 'content-nudge' })

    const { attempts } = await readDiag()
    expect(attempts[0]).toMatchObject({
      trigger: 'content-nudge',
      result: 'retain',
      reported: 3, // what we tried to acknowledge
      received: null, // no 2xx response
      applied: 3, // unchanged — retained
    })
  })

  it('records an unenrolled skip with no network', async () => {
    await runCheckin({ loadClient: mockLoad({ ok: true, response: active(1, false) }), reason: 'alarm' })
    const { attempts } = await readDiag()
    expect(attempts[0]).toMatchObject({ trigger: 'alarm', result: 'skipped-unenrolled' })
  })

  it('records a thrown failure as a content-free error attempt', async () => {
    await enroll()
    const throwingLoad = async () => {
      throw new TypeError('import() is disallowed on ServiceWorkerGlobalScope')
    }
    await expect(runCheckin({ loadClient: throwingLoad, reason: 'alarm' })).rejects.toThrow()

    const { attempts } = await readDiag()
    expect(attempts[0]).toMatchObject({ trigger: 'alarm', result: 'error', error: 'TypeError' })
    // Content-free: only the error NAME, never the message/body.
    expect(attempts[0]?.error).toBe('TypeError')
  })

  it('bounds the ring buffer', async () => {
    for (let i = 0; i < 45; i++) {
      await recordCheckinAttempt({
        at: new Date().toISOString(),
        trigger: 'alarm',
        result: 'noop',
        reported: i,
        received: i,
        applied: i,
      })
    }
    const stored = (await chrome.storage.local.get(TEAMS_DIAG_KEY))[TEAMS_DIAG_KEY] as unknown[]
    expect(stored.length).toBe(40)
  })
})
