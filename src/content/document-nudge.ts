// V1.2 A1 minimal shadow-DOM nudge for the "please re-attach" recovery
// path.
//
// When `releaseFiles()` cannot replay a change through the origin
// input — the source event was a drop / paste, or the DataTransfer
// replay path failed (Gemini closed-shadow-root case) — the flow
// arms the pass-through-once guard and this nudge tells the user
// what to do next. Kept intentionally small: one line of text and a
// close button, closed shadow root so the host page can neither
// restyle nor read it. When A3 lands with the real UX, this
// throwaway is replaced.

const HOST_ATTR = 'data-ai-leak-guard-document-nudge'

let openNudgeHost: HTMLElement | null = null

const STYLES = `
  :host {
    all: initial;
  }
  .nudge {
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
  .nudge__icon {
    font-size: 18px;
    flex: 0 0 auto;
  }
  .nudge__text {
    flex: 1 1 auto;
  }
  .nudge__close {
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
  .nudge__close:hover {
    color: #ffffff;
    background: rgba(255, 255, 255, 0.12);
  }
`

function removeStrayNudges(): void {
  document.querySelectorAll(`[${HOST_ATTR}]`).forEach((node) => {
    node.remove()
  })
}

/**
 * Show a single-line re-attach instruction near the corner of the
 * viewport. Replaces any prior nudge — never stacks. Dismissed by the
 * close button; does not auto-dismiss (a short-lived recovery
 * instruction should stay put until the user acknowledges it).
 */
export function showReattachNudge(message: string): void {
  const mount = document.body ?? document.documentElement
  if (mount === null) return

  removeStrayNudges()
  openNudgeHost?.remove()

  const host = document.createElement('div')
  host.setAttribute(HOST_ATTR, '')
  const shadow = host.attachShadow({ mode: 'closed' })

  const style = document.createElement('style')
  style.textContent = STYLES

  const container = document.createElement('div')
  container.className = 'nudge'
  container.setAttribute('role', 'status')
  container.setAttribute('aria-live', 'polite')

  const icon = document.createElement('span')
  icon.className = 'nudge__icon'
  icon.setAttribute('aria-hidden', 'true')
  icon.textContent = '📎'

  const text = document.createElement('span')
  text.className = 'nudge__text'
  text.textContent = message

  const close = document.createElement('button')
  close.type = 'button'
  close.className = 'nudge__close'
  close.setAttribute('aria-label', 'Dismiss')
  close.title = 'Dismiss'
  close.textContent = '×'
  close.addEventListener('click', () => {
    host.remove()
    if (openNudgeHost === host) openNudgeHost = null
  })

  container.append(icon, text, close)
  shadow.append(style, container)

  mount.appendChild(host)
  openNudgeHost = host
}

/** Test-only reset so leftover nudges do not survive between tests. */
export function __resetNudgeForTests(): void {
  openNudgeHost?.remove()
  openNudgeHost = null
  removeStrayNudges()
}
