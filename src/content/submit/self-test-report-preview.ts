// V1.3.1 §E — pre-open diagnostics PREVIEW.
//
// Before ANY report page opens, the user sees the EXACT content-free
// fields that would be shared and must explicitly proceed. Nothing
// leaves the extension without this. The field list + the pasteable
// block are rendered from the SAME normalized allowlist the report path
// uses (see `self-test-report.ts` → `reportFields`/`buildDiagnosticsBlock`),
// so what the user sees is exactly what could be shared.
//
// DOM only, closed shadow (page CSS can't restyle it, our styles can't
// leak). No network, no free-text input — every field is pre-rendered.

import type { ReportField } from '../../shared/self-test-report'

export interface ReportPreviewDeps {
  /** User confirmed — copy the block + open the report page. */
  readonly onProceed: () => void
  /** User dismissed — nothing opens or is copied. */
  readonly onDismiss?: () => void
}

export interface ReportPreview {
  readonly close: () => void
  readonly host: HTMLElement
  readonly shadow: ShadowRoot
}

const HOST_ATTR = 'data-ai-leak-guard-report-preview'

function removeStray(): void {
  document.querySelectorAll(`[${HOST_ATTR}]`).forEach((n) => n.remove())
}

/**
 * Show the preview panel. Returns a controller. Any previously-open
 * preview is removed first (one at a time).
 */
export function showReportPreview(
  fields: readonly ReportField[],
  block: string,
  deps: ReportPreviewDeps,
): ReportPreview {
  removeStray()

  const host = document.createElement('div')
  host.setAttribute(HOST_ATTR, '')
  const shadow = host.attachShadow({ mode: 'closed' })

  const style = document.createElement('style')
  style.textContent = STYLES

  const backdrop = document.createElement('div')
  backdrop.className = 'backdrop'
  const panel = document.createElement('div')
  panel.className = 'panel'
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-modal', 'true')
  panel.setAttribute('aria-label', 'Report preview')

  const heading = document.createElement('div')
  heading.className = 'heading'
  heading.textContent = 'Before you report — this is everything that will be shared:'

  const note = document.createElement('div')
  note.className = 'note'
  note.textContent =
    'No message text, filenames, detected values, or page URLs are included. Nothing is sent by the extension — proceeding copies the block below and opens the report page for you to paste and submit.'

  const list = document.createElement('dl')
  list.className = 'fields'
  for (const f of fields) {
    const dt = document.createElement('dt')
    dt.textContent = f.label
    const dd = document.createElement('dd')
    dd.textContent = f.value // textContent only — never innerHTML
    list.append(dt, dd)
  }

  // A selectable copy of the exact block, so the user can manually copy
  // even if the clipboard API is unavailable.
  const pre = document.createElement('pre')
  pre.className = 'block'
  pre.textContent = block

  const actions = document.createElement('div')
  actions.className = 'actions'
  const proceed = document.createElement('button')
  proceed.type = 'button'
  proceed.className = 'btn btn--primary'
  proceed.textContent = 'Copy & open report'
  const cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.className = 'btn btn--secondary'
  cancel.textContent = 'Cancel'
  actions.append(cancel, proceed)

  panel.append(heading, note, list, pre, actions)
  backdrop.appendChild(panel)
  shadow.append(style, backdrop)

  let settled = false
  const close = (): void => {
    if (settled) return
    settled = true
    document.removeEventListener('keydown', onKey, true)
    host.remove()
  }
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      const cb = deps.onDismiss
      close()
      cb?.()
    }
  }

  proceed.addEventListener('click', () => {
    close()
    deps.onProceed()
  })
  cancel.addEventListener('click', () => {
    const cb = deps.onDismiss
    close()
    cb?.()
  })
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) {
      const cb = deps.onDismiss
      close()
      cb?.()
    }
  })
  document.addEventListener('keydown', onKey, true)

  const mount = document.body ?? document.documentElement
  mount.appendChild(host)

  return { close, host, shadow }
}

/** Test-only teardown. */
export function __resetReportPreviewForTests(): void {
  removeStray()
}

const STYLES = `
  :host { all: initial; }
  .backdrop {
    position: fixed; inset: 0; z-index: 2147483647;
    display: flex; align-items: center; justify-content: center; padding: 24px;
    background: rgba(15,15,20,0.55);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  }
  .panel {
    background: #1f2024; color: #fff; border-radius: 12px;
    box-shadow: 0 20px 60px rgba(0,0,0,0.45);
    max-width: 460px; width: 100%; max-height: min(80vh, 640px);
    display: flex; flex-direction: column; overflow: auto; padding: 18px 20px;
  }
  .heading { font-size: 14px; font-weight: 600; margin-bottom: 8px; }
  .note { font-size: 12px; line-height: 1.5; color: rgba(255,255,255,0.72); margin-bottom: 12px; }
  .fields { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; margin: 0 0 12px; font-size: 12px; }
  .fields dt { color: rgba(255,255,255,0.6); }
  .fields dd { margin: 0; color: #fff; font-variant-numeric: tabular-nums; word-break: break-word; }
  .block {
    margin: 0 0 14px; padding: 10px; border-radius: 8px;
    background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px;
    line-height: 1.5; white-space: pre-wrap; user-select: all; color: rgba(255,255,255,0.9);
  }
  .actions { display: flex; gap: 8px; justify-content: flex-end; }
  .btn { font: inherit; font-size: 13px; font-weight: 600; padding: 8px 14px; border-radius: 8px; cursor: pointer; border: 1px solid transparent; }
  .btn:focus-visible { outline: 2px solid #7dd3fc; outline-offset: 2px; }
  .btn--primary { background: #7dd3fc; color: #06283b; border-color: #7dd3fc; }
  .btn--secondary { background: transparent; color: rgba(255,255,255,0.85); border-color: rgba(255,255,255,0.25); }
`
