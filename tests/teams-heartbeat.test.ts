// Teams Lite (#78) — content-script heartbeat: an enrolled browser on a managed
// AI tool nudges the worker to check in (background, no popup), gated on
// enrollment and throttled so many tabs / refocus events can't storm the worker.

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  nudgeCheckin,
  TEAMS_LAST_NUDGE_KEY,
  TEAMS_NUDGE_THROTTLE_MS,
} from '../src/content/teams-heartbeat'
import { setEnrollment } from '../src/shared/teams-storage'

const NUDGE = { type: 'alg-teams-checkin', reason: 'content-nudge' }

function chromeRuntime(): { sendMessage: (m: unknown) => Promise<unknown> } {
  return (globalThis as unknown as { chrome: { runtime: { sendMessage: (m: unknown) => Promise<unknown> } } })
    .chrome.runtime
}

async function enroll(): Promise<void> {
  await setEnrollment({
    install_id: 'i',
    install_credential: 'c',
    org_id: 'o',
    org_name: 'Harbor',
    base_url: 'http://127.0.0.1:54321',
  })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('nudgeCheckin — enrollment gate', () => {
  it('does NOT message the worker when the browser is not enrolled', async () => {
    const spy = vi.spyOn(chromeRuntime(), 'sendMessage')
    await nudgeCheckin()
    expect(spy).not.toHaveBeenCalled()
  })

  it('messages the worker once for an enrolled browser and records the throttle stamp', async () => {
    await enroll()
    const spy = vi.spyOn(chromeRuntime(), 'sendMessage')
    await nudgeCheckin()
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith(NUDGE)
    const stamp = (await chrome.storage.local.get(TEAMS_LAST_NUDGE_KEY))[TEAMS_LAST_NUDGE_KEY]
    expect(typeof stamp).toBe('number')
  })
})

describe('nudgeCheckin — throttle', () => {
  it('suppresses a second nudge inside the throttle window', async () => {
    await enroll()
    const spy = vi.spyOn(chromeRuntime(), 'sendMessage')
    await nudgeCheckin() // first: fires
    await nudgeCheckin() // immediate second: throttled
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('allows another nudge once the throttle window has elapsed', async () => {
    await enroll()
    const spy = vi.spyOn(chromeRuntime(), 'sendMessage')
    await nudgeCheckin() // first: fires, stamps "now"
    // Backdate the stamp beyond the window to simulate time passing.
    await chrome.storage.local.set({
      [TEAMS_LAST_NUDGE_KEY]: Date.now() - TEAMS_NUDGE_THROTTLE_MS - 1,
    })
    await nudgeCheckin() // fires again
    expect(spy).toHaveBeenCalledTimes(2)
  })
})
