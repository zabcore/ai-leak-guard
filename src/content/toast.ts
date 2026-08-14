export interface ToastOptions {
  count: number
  labels: string[]
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

// Shows a Shadow DOM confirmation toast in the bottom-right corner. The shadow
// root is 'closed' so the host page cannot read or restyle it. Only one toast
// is visible at a time — a new one dismisses the previous. The toast stays
// until the user clicks the close (×) button; it does not auto-dismiss.
//
// V1.1: this is a pure confirmation surface — no Undo button. Undo would need
// to work reliably across the five very different in-page editors (textarea
// on Gemini/Perplexity, ProseMirror on ChatGPT / Claude, Lexical on Copilot);
// on the contenteditable editors it does not, and shipping a control that
// silently fails would undercut the trust the preview modal is trying to
// build. The preview-before-send modal already gives the user a deliberate
// pre-insertion decision, so Undo is not part of V1.1's safety model.
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

  const close = document.createElement('button')
  close.className = 'toast__close'
  close.type = 'button'
  close.textContent = '×'
  close.setAttribute('aria-label', 'Dismiss')
  close.title = 'Dismiss'
  close.addEventListener('click', () => {
    dismiss()
  })

  container.append(icon, text, close)
  shadow.append(style, container)

  // Defensive: if the document has no body yet, fall back to the root element;
  // if neither exists, skip showing the toast rather than throwing.
  const mount = document.body ?? document.documentElement
  if (mount === null) return NOOP_HANDLE
  mount.appendChild(host)

  active = { host, onDismiss: opts.onDismiss }

  return { dismiss }
}
