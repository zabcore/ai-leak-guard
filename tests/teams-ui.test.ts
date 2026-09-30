// @vitest-environment jsdom
//
// Teams Lite (#78) — popup enrollment UI: each error code maps to the right
// user message, and the DOM flow shows the correct status / affordances.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enrollErrorMessage, setupTeamsSection } from '../src/popup/teams-ui'
import { setEnrollment, setRevokedNotice } from '../src/shared/teams-storage'
import type { EnrollErrorCode } from '../src/shared/teams-contract'

function mountDom(): void {
  document.body.innerHTML = `
    <div id="teams-status"></div>
    <div id="teams-enroll-form">
      <input id="teams-code" />
      <input id="teams-label" />
      <button id="teams-enroll-btn">Enroll</button>
      <p id="teams-error" hidden></p>
    </div>
    <button id="teams-unenroll-btn" hidden></button>`
}

const status = () => document.getElementById('teams-status')?.textContent ?? ''
const form = () => document.getElementById('teams-enroll-form') as HTMLElement
const unenroll = () => document.getElementById('teams-unenroll-btn') as HTMLElement

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('enrollErrorMessage', () => {
  const cases: Array<[EnrollErrorCode, string]> = [
    ['invalid_code', "isn't valid"],
    ['already_used', 'already been used'],
    ['expired', 'expired'],
    ['revoked', 'revoked'],
    ['not_configured', 'isn’t set up'],
    ['network', "Couldn’t reach the server"],
  ]
  it('maps each error code to a distinct, specific message', () => {
    const seen = new Set<string>()
    for (const [code, fragment] of cases) {
      const msg = enrollErrorMessage(code)
      expect(msg).toContain(fragment)
      seen.add(msg)
    }
    // invalid/already/expired/revoked/not_configured/network → at least 6 distinct.
    expect(seen.size).toBeGreaterThanOrEqual(6)
  })
})

describe('setupTeamsSection — status rendering', () => {
  beforeEach(() => {
    mountDom()
  })

  it('not enrolled → shows the form, "Not enrolled", hides Unenroll', async () => {
    await setupTeamsSection()
    expect(status()).toBe('Not enrolled')
    expect(form().hidden).toBe(false)
    expect(unenroll().hidden).toBe(true)
  })

  it('enrolled → shows "Enrolled to <org>" + Unenroll, hides the form', async () => {
    await setEnrollment({
      install_id: 'i',
      install_credential: 'c',
      org_id: 'o',
      org_name: 'Harbor',
      base_url: 'http://127.0.0.1:54321',
    })
    await setupTeamsSection()
    expect(status()).toContain('Enrolled to Harbor')
    expect(form().hidden).toBe(true)
    expect(unenroll().hidden).toBe(false)
  })

  it('revoked (not enrolled) → shows the revoked status', async () => {
    await setRevokedNotice(true)
    await setupTeamsSection()
    expect(status().toLowerCase()).toContain('revoked')
    expect(form().hidden).toBe(false)
  })

  it('clicking Enroll with an empty code shows an inline error and does not proceed', async () => {
    await setupTeamsSection()
    ;(document.getElementById('teams-enroll-btn') as HTMLButtonElement).click()
    await Promise.resolve()
    const err = document.getElementById('teams-error') as HTMLElement
    expect(err.hidden).toBe(false)
    expect(err.textContent).toContain('Enter your enrollment code')
  })
})
