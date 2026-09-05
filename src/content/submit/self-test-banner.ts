// V1.3 M5 (follow-up) — in-tab self-test result banner.
//
// The popup closes the moment the test tab opens (Chrome dismisses the
// action popup on blur), so the outcome must be shown where the user's
// attention actually is: the test tab itself. This renders a small,
// dismissible, theme-aware banner from the terminal self-test state.
//
// DOM only — no network, never submits/resumes, never blocks the page.
// The single outbound action is the optional "Report this" link, which
// the caller wires to open the prefilled zabcore URL via
// `chrome.tabs.create` (the banner just invokes the callback).

import type { SelfTestResultKind, SelfTestCode } from '../../shared/self-test'

export interface SelfTestBannerModel {
  readonly result: SelfTestResultKind
  readonly code: SelfTestCode
}

export interface SelfTestBannerDeps {
  /** Called when the user clicks "Report this" (fail/unsupported, non-draft). */
  readonly onReport?: () => void
  /** Auto-dismiss delay; default 15s. */
  readonly autoDismissMs?: number
  readonly setTimer?: (fn: () => void, ms: number) => number
  readonly clearTimer?: (id: number) => void
}

export interface SelfTestBanner {
  readonly close: () => void
  /** The banner host element (for tests). */
  readonly host: HTMLElement
  /**
   * The banner's (closed) shadow root. Held by the creator only — the
   * closed root keeps the PAGE from reaching it via `host.shadowRoot`,
   * but the caller/tests legitimately have it here.
   */
  readonly shadow: ShadowRoot
  /** True when a "Report this" affordance is shown. */
  readonly hasReport: boolean
}

const HOST_ATTR = 'data-ai-leak-guard-selftest-banner'

const A5_TAIL = ' (This checks detection + the warning, not that a real message was sent.)'

/** The banner copy per terminal state. Exported so tests can pin it. */
export function selfTestBannerCopy(model: SelfTestBannerModel): string {
  if (model.result === 'confirmed') {
    return (
      'AI Leak Guard: protection confirmed. Detection and the send-time warning are working here.' +
      A5_TAIL
    )
  }
  if (model.code === 'DRAFT_PRESENT') {
    return "AI Leak Guard couldn't run the test here because there's already text in the message box. Clear it (or open an empty chat), then click Test protection again."
  }
  return "AI Leak Guard: couldn't confirm protection on this page."
}

/** DRAFT_PRESENT is a "couldn't run here" state, not a protection failure — no report. */
function showsReport(model: SelfTestBannerModel): boolean {
  if (model.code === 'DRAFT_PRESENT') return false
  return model.result === 'fail' || model.result === 'unsupported'
}

function removeStray(): void {
  document.querySelectorAll(`[${HOST_ATTR}]`).forEach((n) => n.remove())
}

/**
 * Render the banner into `document.body`. Returns a controller. Any
 * previously-open self-test banner is removed first (one at a time).
 */
export function showSelfTestBanner(
  model: SelfTestBannerModel,
  deps: SelfTestBannerDeps = {},
): SelfTestBanner {
  removeStray()
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms) as unknown as number)
  const clearTimer = deps.clearTimer ?? ((id: number) => clearTimeout(id))
  const confirmed = model.result === 'confirmed'
  const hasReport = showsReport(model)

  const host = document.createElement('div')
  host.setAttribute(HOST_ATTR, '')
  // Closed shadow root so the host page's CSS can't restyle us and our
  // styles can't leak out — same posture as the warning modal.
  const shadow = host.attachShadow({ mode: 'closed' })

  const style = document.createElement('style')
  style.textContent = STYLES

  const bar = document.createElement('div')
  bar.className = `bar ${confirmed ? 'bar--ok' : 'bar--warn'}`
  bar.setAttribute('role', 'status')
  bar.setAttribute('aria-live', 'polite')

  const icon = document.createElement('span')
  icon.className = 'icon'
  icon.setAttribute('aria-hidden', 'true')
  icon.textContent = confirmed ? '🛡' : '⚠️'

  const msg = document.createElement('span')
  msg.className = 'msg'
  msg.textContent = selfTestBannerCopy(model)

  const actions = document.createElement('span')
  actions.className = 'actions'

  let timerId: number | null = null
  const close = (): void => {
    if (timerId !== null) {
      clearTimer(timerId)
      timerId = null
    }
    host.remove()
  }

  if (hasReport) {
    const report = document.createElement('button')
    report.type = 'button'
    report.className = 'btn btn--report'
    report.textContent = 'Report this'
    report.addEventListener('click', () => {
      try {
        deps.onReport?.()
      } catch {
        // best-effort; a report failure never breaks the page
      }
    })
    actions.appendChild(report)
  }

  const closeBtn = document.createElement('button')
  closeBtn.type = 'button'
  closeBtn.className = 'btn btn--close'
  closeBtn.setAttribute('aria-label', 'Dismiss')
  closeBtn.textContent = 'Close'
  closeBtn.addEventListener('click', close)
  actions.appendChild(closeBtn)

  bar.append(icon, msg, actions)
  shadow.append(style, bar)

  const mount = document.body ?? document.documentElement
  mount.appendChild(host)

  const autoMs = deps.autoDismissMs ?? 15000
  if (autoMs > 0) timerId = setTimer(close, autoMs)

  return { close, host, shadow, hasReport }
}

const STYLES = `
  :host { all: initial; }
  .bar {
    position: fixed;
    top: 12px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 2147483647;
    max-width: min(560px, calc(100vw - 24px));
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 12px;
    border-radius: 10px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    font-size: 13px;
    line-height: 1.4;
    box-shadow: 0 10px 30px rgba(0,0,0,0.25);
    color: #10241a;
    background: #e9f9ef;
    border: 1px solid #9fdcb4;
  }
  .bar--warn {
    color: #3a2a00;
    background: #fff6e0;
    border-color: #f0d28a;
  }
  .icon { font-size: 16px; flex: 0 0 auto; }
  .msg { flex: 1 1 auto; }
  .actions { flex: 0 0 auto; display: flex; gap: 6px; }
  .btn {
    font: inherit;
    font-size: 12px;
    font-weight: 600;
    padding: 4px 8px;
    border-radius: 6px;
    cursor: pointer;
    border: 1px solid transparent;
    background: rgba(0,0,0,0.06);
    color: inherit;
  }
  .btn:hover { background: rgba(0,0,0,0.12); }
  .btn--report { border-color: rgba(138,28,28,0.4); }
  @media (prefers-color-scheme: dark) {
    .bar {
      color: #d7f5e3;
      background: #163124;
      border-color: #2f6b47;
    }
    .bar--warn {
      color: #f6e4bd;
      background: #3a2f13;
      border-color: #7a5f22;
    }
    .btn { background: rgba(255,255,255,0.10); }
    .btn:hover { background: rgba(255,255,255,0.18); }
  }
`

/** Test-only teardown. */
export function __resetSelfTestBannerForTests(): void {
  removeStray()
}
