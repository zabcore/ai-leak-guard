// Teams Lite (#78) — the popup enrollment UI wiring.
//
// Enters/clears enrollment and shows a status line. The heavy lifting (network,
// storage, state machine) lives in `enterprise/teams-service`; this file only
// wires the DOM and maps error codes to user-facing copy. The enrollment client
// itself is loaded lazily by the service (dynamic import) and only on the
// explicit Activate click, so merely opening the popup issues no network call.
//
// UX: the section is COLLAPSED by default — a Free user sees only a quiet
// "Team management · Not set up" row with an "Activate" affordance. The code
// field is revealed (progressive disclosure) only when they choose to activate,
// so the everyday popup stays uncluttered.

import { runCheckin, runEnroll, runUnenroll } from '../enterprise/teams-service'
import { getEnrollment, getRevokedNotice } from '../shared/teams-storage'
import type { EnrollErrorCode } from '../shared/teams-contract'

/** Map an enroll error code to the specific user-facing message. Pure — tested. */
export function enrollErrorMessage(code: EnrollErrorCode): string {
  switch (code) {
    case 'invalid_code':
      return "That code isn't valid. Double-check it and try again."
    case 'already_used':
      return 'That code has already been used. Ask your admin for a new one.'
    case 'expired':
      return 'That code has expired. Ask your admin for a new one.'
    case 'revoked':
      return 'That code was revoked. Ask your admin for a new one.'
    case 'not_configured':
      return 'Team management isn’t set up in this build.'
    case 'network':
    default:
      return 'Couldn’t reach the server. Check your connection and try again.'
  }
}

interface TeamsEls {
  status: HTMLElement
  form: HTMLElement
  code: HTMLInputElement
  label: HTMLInputElement
  enrollBtn: HTMLButtonElement
  error: HTMLElement
  unenrollBtn: HTMLButtonElement
  // Optional progressive-disclosure controls (present in the real popup; a
  // minimal test DOM may omit them, in which case the form is shown directly).
  activateBtn: HTMLButtonElement | null
  cancelBtn: HTMLButtonElement | null
  icon: HTMLElement | null
}

function resolveEls(): TeamsEls | null {
  const status = document.getElementById('teams-status')
  const form = document.getElementById('teams-enroll-form')
  const code = document.getElementById('teams-code')
  const label = document.getElementById('teams-label')
  const enrollBtn = document.getElementById('teams-enroll-btn')
  const error = document.getElementById('teams-error')
  const unenrollBtn = document.getElementById('teams-unenroll-btn')
  if (
    !(status instanceof HTMLElement) ||
    !(form instanceof HTMLElement) ||
    !(code instanceof HTMLInputElement) ||
    !(label instanceof HTMLInputElement) ||
    !(enrollBtn instanceof HTMLButtonElement) ||
    !(error instanceof HTMLElement) ||
    !(unenrollBtn instanceof HTMLButtonElement)
  ) {
    return null
  }
  const activateEl = document.getElementById('teams-activate-btn')
  const cancelEl = document.getElementById('teams-cancel-btn')
  return {
    status,
    form,
    code,
    label,
    enrollBtn,
    error,
    unenrollBtn,
    activateBtn: activateEl instanceof HTMLButtonElement ? activateEl : null,
    cancelBtn: cancelEl instanceof HTMLButtonElement ? cancelEl : null,
    icon: document.getElementById('teams-icon'),
  }
}

/** A sensible default install label when the operator leaves it blank. */
function defaultLabel(): string {
  return 'Chrome'
}

function setStatus(els: TeamsEls, text: string, variant: '' | 'managed' | 'revoked'): void {
  els.status.textContent = text
  els.status.classList.remove('teams__status--managed', 'teams__status--revoked')
  if (variant !== '') els.status.classList.add(`teams__status--${variant}`)
  if (els.icon !== null) els.icon.style.color = variant === 'managed' ? '#087152' : ''
}

/** Show the collapsed state (status + Activate affordance, form hidden). If the
 *  popup has no Activate button (minimal test DOM), show the form directly. */
function collapse(els: TeamsEls): void {
  els.error.hidden = true
  if (els.activateBtn !== null) {
    els.form.hidden = true
    els.activateBtn.hidden = false
  } else {
    els.form.hidden = false
  }
}

/** Reveal the enrollment form (progressive disclosure). */
function expand(els: TeamsEls): void {
  els.form.hidden = false
  if (els.activateBtn !== null) els.activateBtn.hidden = true
  els.error.hidden = true
  try {
    els.code.focus()
  } catch {
    // focus is best-effort
  }
}

async function render(els: TeamsEls): Promise<void> {
  const enrollment = await getEnrollment()
  if (enrollment !== null) {
    setStatus(els, `Managed by ${enrollment.org_name}`, 'managed')
    els.form.hidden = true
    if (els.activateBtn !== null) els.activateBtn.hidden = true
    els.unenrollBtn.hidden = false
    els.error.hidden = true
    return
  }
  els.unenrollBtn.hidden = true
  const revoked = await getRevokedNotice()
  if (revoked) {
    setStatus(els, 'Removed by your organization', 'revoked')
    if (els.activateBtn !== null) els.activateBtn.textContent = 'Activate again'
  } else {
    setStatus(els, 'Not set up', '')
    if (els.activateBtn !== null) els.activateBtn.textContent = 'Activate'
  }
  collapse(els)
}

function showError(els: TeamsEls, message: string): void {
  els.error.textContent = message
  els.error.hidden = false
}

/** Ask the service worker to run a check-in immediately after enrolling. */
function requestImmediateCheckin(): void {
  try {
    const rt = (globalThis as { chrome?: { runtime?: { sendMessage?: (m: unknown) => unknown } } })
      .chrome?.runtime
    if (rt && typeof rt.sendMessage === 'function') {
      const maybePromise = rt.sendMessage({ type: 'alg-teams-checkin', reason: 'post-enroll' }) as
        | Promise<unknown>
        | undefined
      if (maybePromise && typeof maybePromise.then === 'function') void maybePromise.catch(() => {})
    }
  } catch {
    // best-effort — the scheduled alarm will pick it up otherwise.
  }
}

/** Wire the enrollment section. Best-effort — never throws into popup init. */
export async function setupTeamsSection(): Promise<void> {
  const els = resolveEls()
  if (els === null) return

  await render(els)

  // If enrolled, refresh managed settings from the backend NOW, from the popup's
  // own context. The background service worker can be torn down before its
  // check-in fetch completes (MV3), so a popup-context check-in is the reliable
  // path — and it means an MSP's change shows up the moment the user opens the
  // popup, not only on the next background tick.
  try {
    if ((await getEnrollment()) !== null) {
      void runCheckin({ reason: 'popup' }).then(() => render(els))
    }
  } catch {
    // best-effort
  }

  els.activateBtn?.addEventListener('click', () => expand(els))
  els.cancelBtn?.addEventListener('click', () => {
    els.code.value = ''
    void render(els)
  })

  els.enrollBtn.addEventListener('click', () => {
    void (async () => {
      els.error.hidden = true
      const code = els.code.value.trim()
      if (code === '') {
        showError(els, 'Enter your enrollment code.')
        return
      }
      const label = els.label.value.trim() || defaultLabel()
      els.enrollBtn.disabled = true
      els.enrollBtn.textContent = 'Activating…'
      try {
        const result = await runEnroll(code, label)
        if (result.ok) {
          els.code.value = ''
          els.label.value = ''
          void runCheckin({ reason: 'popup' }).then(() => render(els)) // popup-context: apply now
          requestImmediateCheckin() // also nudge the background worker
          await render(els)
        } else {
          showError(els, enrollErrorMessage(result.code))
        }
      } catch {
        showError(els, enrollErrorMessage('network'))
      } finally {
        els.enrollBtn.disabled = false
        els.enrollBtn.textContent = 'Activate'
      }
    })()
  })

  els.unenrollBtn.addEventListener('click', () => {
    void (async () => {
      els.unenrollBtn.disabled = true
      try {
        await runUnenroll()
      } finally {
        els.unenrollBtn.disabled = false
      }
      await render(els)
    })()
  })
}
