// V1.3.3 — the compact in-page AVAILABILITY indicator.
//
// A small, NON-INTERACTIVE pill that renders ONLY where the extension is
// active here (a composer resolves right now + the toggle is on). It states
// availability, never "you are protected", and exposes the signals SEPARATELY
// (composer / paste / send / file scanning / last self-test) — there is no
// single composite status.
//
// Anti-stale-green by construction: `refresh()` re-reads availability from the
// caller (which resolves the composer live), and removes the host whenever the
// surface is not active — so a prior self-test pass can never keep it on screen
// once the composer is gone.
//
// It cannot announce its OWN total absence (if the content script never loads,
// nothing renders) — the copy says so and points at the toolbar self-test and
// Gate C as the backstops.

import type { Availability, SignalState, SelfTestSignalInfo } from './availability'
import type { SendMode } from '../shared/coverage'

const HOST_ATTR = 'data-ai-leak-guard-availability'

export interface AvailabilityIndicatorDeps {
  /** Live availability, or null when not on an in-scope surface. */
  readonly getAvailability: () => Availability | null
  /** Where to mount (default `document.body`). */
  readonly mount?: () => ParentNode | null
}

export interface AvailabilityIndicator {
  /** Re-evaluate availability and (un)render accordingly. Safe to call often. */
  refresh(): void
  /** Remove the host and stop rendering. */
  destroy(): void
}

const STYLE = `
  :host { all: initial; }
  .alg-ind {
    position: fixed; right: 12px; bottom: 12px; z-index: 2147483000;
    pointer-events: none; /* purely informational — never intercepts input */
    max-width: 260px;
    font: 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    color: #0b1324; background: #ffffff; border: 1px solid #d7dbe3;
    border-radius: 10px; box-shadow: 0 2px 10px rgba(11,19,36,0.12);
    padding: 8px 10px; opacity: 0.96;
  }
  .alg-ind__header { font-weight: 600; display: flex; align-items: center; gap: 6px; }
  .alg-ind__dot { width: 8px; height: 8px; border-radius: 50%; background: #1a7f37; flex: none; }
  .alg-ind__sub { color: #5b6472; margin: 1px 0 6px; }
  .alg-ind__signals { display: grid; grid-template-columns: 1fr; gap: 2px; }
  .alg-ind__signal { display: flex; justify-content: space-between; gap: 10px; }
  .alg-ind__label { color: #3a4252; }
  .alg-ind__value { color: #0b1324; }
  .alg-ind__value--on { color: #1a7f37; }
  .alg-ind__value--off { color: #8a94a6; }
  .alg-ind__note { color: #5b6472; margin-top: 6px; border-top: 1px solid #eceef2; padding-top: 6px; }
`

function signalValue(state: SignalState, sendMode?: SendMode): string {
  if (state === 'ready') {
    if (sendMode === 'no-resume-two-press') return 'on (press Send again)'
    if (sendMode === 'resume') return 'on'
    return 'on'
  }
  if (state === 'unvalidated') return 'unverified here'
  return 'not on this surface'
}

function selfTestValue(info: SelfTestSignalInfo | null): string {
  if (info === null) return 'not run'
  const mins = Math.floor(info.ageMs / 60000)
  const age = mins <= 0 ? 'just now' : `${mins}m ago`
  const label = info.result === 'confirmed' ? 'passed' : info.result
  return info.stale ? `${label} ${age} (stale)` : `${label} ${age}`
}

/** Create (once) the pill's shadow structure; returns the container to fill. */
export function createAvailabilityIndicator(
  deps: AvailabilityIndicatorDeps,
): AvailabilityIndicator {
  let host: HTMLElement | null = null

  const removeHost = (): void => {
    host?.remove()
    host = null
  }

  const render = (a: Availability): void => {
    const mountPoint = (deps.mount?.() ?? document.body) as ParentNode | null
    if (mountPoint === null) return
    if (host === null) {
      host = document.createElement('div')
      host.setAttribute(HOST_ATTR, '')
      // Open shadow: the content is non-sensitive availability labels (no user
      // data), and an open root lets the page-agnostic styles apply and keeps
      // the pill inspectable. Distinct host from the (closed) warning modals.
      host.attachShadow({ mode: 'open' })
      ;(mountPoint as ParentNode & { appendChild: (n: Node) => void }).appendChild(host)
    }
    const shadow = host.shadowRoot
    if (shadow === null) return

    const signal = (id: string, label: string, value: string, on: boolean): string =>
      `<div class="alg-ind__signal" data-signal="${id}">` +
      `<span class="alg-ind__label">${label}</span>` +
      `<span class="alg-ind__value ${on ? 'alg-ind__value--on' : 'alg-ind__value--off'}">${value}</span>` +
      `</div>`

    shadow.innerHTML =
      `<style>${STYLE}</style>` +
      `<div class="alg-ind" role="status" aria-live="off">` +
      `<div class="alg-ind__header"><span class="alg-ind__dot"></span>AI Leak Guard · active here</div>` +
      `<div class="alg-ind__sub">Availability, not a guarantee</div>` +
      `<div class="alg-ind__signals">` +
      signal('composer', 'Composer detected', a.composerPresent ? 'yes' : 'no', a.composerPresent) +
      signal('paste', 'Paste scanning', signalValue(a.paste), a.paste === 'ready') +
      signal('send', 'Send-time check', signalValue(a.send, a.sendMode), a.send === 'ready') +
      signal('file', 'File scanning', signalValue(a.fileScanning), a.fileScanning === 'ready') +
      signal(
        'selftest',
        'Last self-test',
        selfTestValue(a.lastSelfTest),
        a.lastSelfTest?.result === 'confirmed' && a.lastSelfTest.stale === false,
      ) +
      `</div>` +
      `<div class="alg-ind__note">Can't confirm every surface — run “Test protection” from the toolbar; Gate C watches for drift.</div>` +
      `</div>`
  }

  const refresh = (): void => {
    let a: Availability | null
    try {
      a = deps.getAvailability()
    } catch {
      a = null
    }
    // Render ONLY when active here. Not active (no composer / disabled / not a
    // covered surface) → remove the host so it never reads ready. This is the
    // anti-stale-green guarantee.
    if (a === null || !a.activeHere) {
      removeHost()
      return
    }
    render(a)
  }

  return { refresh, destroy: removeHost }
}

export { HOST_ATTR as AVAILABILITY_HOST_ATTR }
