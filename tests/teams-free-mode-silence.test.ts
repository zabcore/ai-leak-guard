// @vitest-environment jsdom
//
// Teams Lite (#78) — hard requirement 1, proven BEHAVIORALLY: an unenrolled
// (Free) install makes ZERO network calls. The guarantee is behavioral, not a
// claim that the bundle has no `fetch` in it — so this test installs a global
// `fetch` spy and exercises the real entry points with the DEFAULT (dynamic-
// import) client, asserting silence when unenrolled and — to prove the gate is
// real, not a missing capability — a call when enrolled.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runCheckin } from '../src/enterprise/teams-service'
import { setupTeamsSection } from '../src/popup/teams-ui'
import { setEnrollment } from '../src/shared/teams-storage'

let fetchSpy: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchSpy = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      revoked: false,
      org_id: 'org_1',
      target_settings_revision: 1,
      settings: { show_indicator: true },
    }),
  }))
  ;(globalThis as { fetch: unknown }).fetch = fetchSpy
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  delete (globalThis as { fetch?: unknown }).fetch
  document.body.innerHTML = ''
})

describe('Free mode is network-silent', () => {
  it('unenrolled runCheckin makes NO network call (uses the real dynamic-import client path)', async () => {
    vi.stubEnv('VITE_TEAMS_BASE_URL', 'http://127.0.0.1:54321')
    vi.stubEnv('VITE_TEAMS_ANON_KEY', 'anon')
    // Storage is empty (setup clears it) → not enrolled.
    const outcome = await runCheckin() // DEFAULT loadClient (dynamic import)
    expect(outcome).toBe('skipped-unenrolled')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('repeated unenrolled check-ins stay silent', async () => {
    vi.stubEnv('VITE_TEAMS_BASE_URL', 'http://127.0.0.1:54321')
    vi.stubEnv('VITE_TEAMS_ANON_KEY', 'anon')
    await runCheckin()
    await runCheckin()
    await runCheckin()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('opening the popup enrollment section issues no network call', async () => {
    // @vitest-environment jsdom is implied by jsdom global; build minimal DOM.
    document.body.innerHTML = `
      <div id="teams-status"></div>
      <div id="teams-enroll-form">
        <input id="teams-code" /><input id="teams-label" />
        <button id="teams-enroll-btn"></button>
        <p id="teams-error"></p>
      </div>
      <button id="teams-unenroll-btn"></button>`
    await setupTeamsSection()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('an ENROLLED check-in DOES call the backend (proves the gate is behavioral, not a missing capability)', async () => {
    vi.stubEnv('VITE_TEAMS_BASE_URL', 'http://127.0.0.1:54321')
    vi.stubEnv('VITE_TEAMS_ANON_KEY', 'anon')
    await setEnrollment({
      install_id: 'inst_1',
      install_credential: 'cred_1',
      org_id: 'org_1',
      org_name: 'Harbor',
      base_url: 'http://127.0.0.1:54321',
    })
    await runCheckin() // DEFAULT loadClient → real teams-client → global fetch
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url] = fetchSpy.mock.calls[0] as [string]
    expect(url).toBe('http://127.0.0.1:54321/functions/v1/checkin')
  })
})
