import type { UndoOutcome } from './undo'

export interface ToastOptions {
  count: number
  labels: string[]
  // Returns the undo outcome. 'restored' dismisses the toast; 'partial' and
  // 'failed' keep it open with an explanatory message.
  onUndo: () => UndoOutcome
  onDismiss?: () => void
}

export interface ToastHandle {
  dismiss: () => void
}

const NOOP_HANDLE: ToastHandle = { dismiss: () => {} }

// Marks our toast host so we can guarantee a single toast in the DOM even if a
// second content-script instance (e.g. another frame) also rendered one.
const HOST_ATTR = 'data-ai-leak-guard-toast'

interface ActiveToast {
  host: HTMLElement
  onDismiss?: () => void
}

let active: ActiveToast | null = null

function dismiss(): void {
  if (active === null) return
  active.host.remove()
  const onDismiss = active.onDismiss
  active = null
  onDismiss?.()
}

// Removes any toast hosts left in the DOM, including ones this module instance
// doesn't track, so toasts can never stack.
function removeStrayToasts(): void {
  const root = document.body ?? document.documentElement
  root?.querySelectorAll(`[${HOST_ATTR}]`).forEach((node) => {
    node.remove()
  })
}

const STYLES = `
  .toast {
    position: fixed;
    bottom: 20px;
    right: 20px;
    z-index: 2147483647;
    display: flex;
    align-items: center;
    gap: 10px;
    max-width: 420px;
    padding: 12px 14px;
    background: #1a1a1a;
    color: #ffffff;
    border-radius: 10px;
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.35);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    font-size: 13px;
    line-height: 1.4;
  }
  .toast__icon {
    font-size: 18px;
    flex: 0 0 auto;
  }
  .toast__text {
    flex: 1 1 auto;
  }
  .toast__text--error {
    color: #f87171;
  }
  .toast__undo {
    flex: 0 0 auto;
    padding: 6px 12px;
    background: transparent;
    color: #4ade80;
    border: 1px solid #4ade80;
    border-radius: 6px;
    font: inherit;
    font-weight: 600;
    cursor: pointer;
  }
  .toast__undo:hover {
    background: rgba(74, 222, 128, 0.12);
  }
  .toast__close {
    flex: 0 0 auto;
    width: 24px;
    height: 24px;
    padding: 0;
    background: transparent;
    color: rgba(255, 255, 255, 0.55);
    border: none;
    border-radius: 6px;
    font-size: 18px;
    line-height: 1;
    cursor: pointer;
  }
  .toast__close:hover {
    color: #ffffff;
    background: rgba(255, 255, 255, 0.12);
  }
`

// Shows a Shadow DOM toast in the bottom-right corner. The shadow root uses
// mode 'closed' so the host page cannot read or restyle it. Only one toast is
// visible at a time — a new one dismisses the previous. The toast stays until
// the user clicks Undo or the close (×) button; it does not auto-dismiss.
export function showToast(opts: ToastOptions): ToastHandle {
  dismiss()
  removeStrayToasts()

  const host = document.createElement('div')
  host.setAttribute(HOST_ATTR, '')
  const shadow = host.attachShadow({ mode: 'closed' })

  const style = document.createElement('style')
  style.textContent = STYLES

  const container = document.createElement('div')
  container.className = 'toast'

  const icon = document.createElement('span')
  icon.className = 'toast__icon'
  icon.textContent = '🛡'

  const noun = opts.count === 1 ? 'item' : 'items'
  const text = document.createElement('span')
  text.className = 'toast__text'
  text.textContent = `${opts.count} sensitive ${noun} masked (${opts.labels.join(', ')})`

  const undo = document.createElement('button')
  undo.className = 'toast__undo'
  undo.type = 'button'
  undo.textContent = 'Undo'
  undo.addEventListener('click', () => {
    const outcome = opts.onUndo()
    if (outcome === 'restored') {
      dismiss()
      return
    }
    undo.disabled = true
    text.className = 'toast__text toast__text--error'
    text.textContent =
      outcome === 'partial'
        ? "Couldn't fully restore — some items were edited. Please check the field."
        : "Couldn't undo automatically — please clear the field manually."
  })

  const close = document.createElement('button')
  close.className = 'toast__close'
  close.type = 'button'
  close.textContent = '×'
  close.setAttribute('aria-label', 'Dismiss')
  close.title = 'Dismiss'
  close.addEventListener('click', () => {
    dismiss()
  })

  container.append(icon, text, undo, close)
  shadow.append(style, container)

  // Defensive: if the document has no body yet, fall back to the root element;
  // if neither exists, skip showing the toast rather than throwing.
  const mount = document.body ?? document.documentElement
  if (mount === null) return NOOP_HANDLE
  mount.appendChild(host)

  active = { host, onDismiss: opts.onDismiss }

  return { dismiss }
}
