// Teams Lite (#78) — the popup enrollment UI wiring.
//
// Enters/clears enrollment and shows a status line. The heavy lifting (network,
// storage, state machine) lives in `enterprise/teams-service`; this file only
// wires the DOM and maps error codes to user-facing copy. The enrollment client
// itself is loaded lazily by the service (dynamic import) and only on the
// explicit Enroll click, so merely opening the popup issues no network call.

import { runEnroll, runUnenroll } from '../enterprise/teams-service'
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
  return { status, form, code, label, enrollBtn, error, unenrollBtn }
}

/** A sensible default install label when the operator leaves it blank. */
function defaultLabel(): string {
  return 'Chrome'
}

async function render(els: TeamsEls): Promise<void> {
  const enrollment = await getEnrollment()
  if (enrollment !== null) {
    els.status.textContent = `Enrolled to ${enrollment.org_name}`
    els.form.hidden = true
    els.unenrollBtn.hidden = false
    els.error.hidden = true
    return
  }
  const revoked = await getRevokedNotice()
  els.status.textContent = revoked
    ? 'Enrollment was revoked by your organization.'
    : 'Not enrolled'
  els.form.hidden = false
  els.unenrollBtn.hidden = true
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
      const maybePromise = rt.sendMessage({ type: 'alg-teams-checkin' }) as
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
      els.enrollBtn.textContent = 'Enrolling…'
      try {
        const result = await runEnroll(code, label)
        if (result.ok) {
          els.code.value = ''
          requestImmediateCheckin()
          await render(els)
        } else {
          showError(els, enrollErrorMessage(result.code))
        }
      } catch {
        showError(els, enrollErrorMessage('network'))
      } finally {
        els.enrollBtn.disabled = false
        els.enrollBtn.textContent = 'Enroll'
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
