export interface ToastOptions {
  count: number
  labels: string[]
  onUndo: () => void
  onDismiss?: () => void
  durationMs?: number
}

export interface ToastHandle {
  dismiss: () => void
  disableUndo: () => void
}

const DEFAULT_DURATION_MS = 6000
const NOOP_HANDLE: ToastHandle = { dismiss: () => {}, disableUndo: () => {} }

interface ActiveToast {
  host: HTMLElement
  timer: ReturnType<typeof setTimeout>
  onDismiss?: () => void
}

let active: ActiveToast | null = null

function dismiss(): void {
  if (active === null) return
  clearTimeout(active.timer)
  active.host.remove()
  const onDismiss = active.onDismiss
  active = null
  onDismiss?.()
}

const STYLES = `
  .toast {
    position: fixed;
    bottom: 20px;
    right: 20px;
    z-index: 2147483647;
    display: flex;
    align-items: center;
    gap: 12px;
    max-width: 380px;
    padding: 12px 16px;
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
  .toast__undo:disabled {
    opacity: 0.45;
    cursor: default;
    color: #9ca3af;
    border-color: #9ca3af;
    background: transparent;
  }
`

// Shows a Shadow DOM toast in the bottom-right corner. The shadow root uses
// mode 'closed' so the host page cannot read or restyle it. Only one toast is
// visible at a time — a new one dismisses the previous.
export function showToast(opts: ToastOptions): ToastHandle {
  dismiss()

  const host = document.createElement('div')
  const shadow = host.attachShadow({ mode: 'closed' })

  const style = document.createElement('style')
  style.textContent = STYLES

  const container = document.createElement('div')
  container.className = 'toast'

  const icon = document.createElement('span')
  icon.className = 'toast__icon'
  icon.textContent = '🛡'

  const noun = opts.count === 1 ? 'item' : 'items'
  const baseMessage = `${opts.count} sensitive ${noun} masked (${opts.labels.join(', ')})`

  const text = document.createElement('span')
  text.className = 'toast__text'
  text.textContent = baseMessage

  const undo = document.createElement('button')
  undo.className = 'toast__undo'
  undo.type = 'button'
  undo.textContent = 'Undo'
  undo.addEventListener('click', () => {
    dismiss()
    opts.onUndo()
  })

  container.append(icon, text, undo)
  shadow.append(style, container)

  // Defensive: if the document has no body yet, fall back to the root element;
  // if neither exists, skip showing the toast rather than throwing.
  const mount = document.body ?? document.documentElement
  if (mount === null) return NOOP_HANDLE
  mount.appendChild(host)

  const duration = opts.durationMs ?? DEFAULT_DURATION_MS
  active = { host, timer: setTimeout(dismiss, duration), onDismiss: opts.onDismiss }

  return {
    dismiss,
    disableUndo: () => {
      undo.disabled = true
      undo.title = 'Undo is unavailable because the input changed after masking'
      text.textContent = `${baseMessage} — input changed, undo disabled`
    },
  }
}
