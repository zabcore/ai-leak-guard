// @vitest-environment jsdom
//
// Teams Lite (#78) — popup enrollment UI: each error code maps to the right
// user message, and the DOM flow shows the correct status / affordances. The
// section is collapsed by default (progressive disclosure): a Free user sees a
// quiet status + an "Activate" button, and the code field appears only after
// Activate is clicked.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enrollErrorMessage, setupTeamsSection } from '../src/popup/teams-ui'
import { setEnrollment, setRevokedNotice } from '../src/shared/teams-storage'
import type { EnrollErrorCode } from '../src/shared/teams-contract'

function mountDom(): void {
  document.body.innerHTML = `
    <section id="teams-section">
      <div class="teams__bar">
        <span id="teams-icon"></span>
        <p id="teams-status"></p>
        <button id="teams-activate-btn">Activate</button>
        <button id="teams-unenroll-btn" hidden></button>
      </div>
      <div id="teams-enroll-form" hidden>
        <input id="teams-code" />
        <input id="teams-label" />
        <div>
          <button id="teams-enroll-btn">Activate</button>
          <button id="teams-cancel-btn">Cancel</button>
        </div>
        <p id="teams-error" hidden></p>
      </div>
    </section>`
}

const status = () => document.getElementById('teams-status')?.textContent ?? ''
const form = () => document.getElementById('teams-enroll-form') as HTMLElement
const unenroll = () => document.getElementById('teams-unenroll-btn') as HTMLElement
const activate = () => document.getElementById('teams-activate-btn') as HTMLButtonElement

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
    expect(seen.size).toBeGreaterThanOrEqual(6)
  })
})

describe('setupTeamsSection — status rendering', () => {
  beforeEach(() => {
    mountDom()
  })

  it('not set up → collapsed: status "Not set up", form hidden, Activate shown, Remove hidden', async () => {
    await setupTeamsSection()
    expect(status()).toBe('Not set up')
    expect(form().hidden).toBe(true)
    expect(activate().hidden).toBe(false)
    expect(unenroll().hidden).toBe(true)
  })

  it('clicking Activate reveals the enrollment form', async () => {
    await setupTeamsSection()
    activate().click()
    await Promise.resolve()
    expect(form().hidden).toBe(false)
    expect(activate().hidden).toBe(true)
  })

  it('enrolled → "Managed by <org>" + Remove, form + Activate hidden', async () => {
    await setEnrollment({
      install_id: 'i',
      install_credential: 'c',
      org_id: 'o',
      org_name: 'Harbor',
      base_url: 'http://127.0.0.1:54321',
    })
    await setupTeamsSection()
    expect(status()).toContain('Managed by Harbor')
    expect(form().hidden).toBe(true)
    expect(activate().hidden).toBe(true)
    expect(unenroll().hidden).toBe(false)
  })

  it('revoked (not enrolled) → shows a removed status and offers Activate again', async () => {
    await setRevokedNotice(true)
    await setupTeamsSection()
    expect(status().toLowerCase()).toContain('removed')
    expect(form().hidden).toBe(true)
    expect(activate().textContent).toContain('Activate again')
  })

  it('Activate → empty code shows an inline error and does not proceed', async () => {
    await setupTeamsSection()
    activate().click()
    await Promise.resolve()
    ;(document.getElementById('teams-enroll-btn') as HTMLButtonElement).click()
    await Promise.resolve()
    const err = document.getElementById('teams-error') as HTMLElement
    expect(err.hidden).toBe(false)
    expect(err.textContent).toContain('Enter your enrollment code')
  })
})
