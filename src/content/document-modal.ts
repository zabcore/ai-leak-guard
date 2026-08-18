// V1.2 A1 placeholder confirm modal for the document-protection flow.
//
// Reuses the Shadow-DOM / focus-trap / promise-outcome pattern from
// V1.1's `preview-modal.ts`. Two outcomes only, as spec'd:
//
//   'upload-anyway'  → release the ORIGINAL file to the host
//   'cancel'         → discard; nothing uploads
//
// There is NO third "protected version" outcome in V1.2 — document
// protection warns, never blocks. The primary button is "Upload anyway"
// on purpose: the modal is a heads-up, not a gate. Cancel is one
// keystroke (Escape) or one click (× / backdrop) away.
//
// The A1 body is intentionally minimal — just a count and a short
// static line explaining that content inspection lands in a later
// release. When the real inspector arrives in A2/A3 the copy grows,
// but the resolution shape (`Promise<'upload-anyway' | 'cancel'>`)
// stays fixed.

export type DocumentModalOutcome = 'upload-anyway' | 'cancel'

export interface DocumentModalOptions {
  /** How many files the user selected / dropped / pasted. */
  readonly fileCount: number
  /**
   * The element that had focus when the file event was intercepted.
   * Focus returns here when the modal closes (regardless of outcome)
   * so the composer is ready for the next keystroke on cancel.
   */
  readonly opener: Element | null
}

const HOST_ATTR = 'data-ai-leak-guard-document-modal'

let openModalHost: HTMLElement | null = null
let activeCancel: (() => void) | null = null

/** True while a document-protection modal is on screen. */
export function isDocumentModalOpen(): boolean {
  return openModalHost !== null
}

const STYLES = `
  :host {
    all: initial;
  }
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 2147483647;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    background: rgba(15, 15, 20, 0.55);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    color: #ffffff;
  }
  .dialog {
    background: #1f2024;
    color: #ffffff;
    border-radius: 12px;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.45);
    max-width: 520px;
    width: 100%;
    max-height: min(60vh, 480px);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    outline: none;
  }
  .heading {
    padding: 18px 20px 6px;
    font-size: 15px;
    font-weight: 600;
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .heading__icon {
    font-size: 18px;
  }
  .body {
    padding: 6px 20px 16px;
    font-size: 13px;
    color: rgba(255, 255, 255, 0.78);
    line-height: 1.5;
  }
  .actions {
    padding: 12px 20px 18px;
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    border-top: 1px solid rgba(255, 255, 255, 0.06);
  }
  .btn {
    padding: 8px 14px;
    font: inherit;
    font-size: 13px;
    font-weight: 600;
    border-radius: 8px;
    cursor: pointer;
    border: 1px solid transparent;
  }
  .btn:focus-visible {
    outline: 2px solid #7dd3fc;
    outline-offset: 2px;
  }
  .btn--primary {
    background: #f59e0b;
    color: #1a0f00;
    border-color: #f59e0b;
  }
  .btn--primary:hover {
    background: #d97706;
    border-color: #d97706;
  }
  .btn--secondary {
    background: transparent;
    color: rgba(255, 255, 255, 0.85);
    border-color: rgba(255, 255, 255, 0.25);
  }
  .btn--secondary:hover {
    background: rgba(255, 255, 255, 0.06);
  }
  .close {
    position: absolute;
    top: 14px;
    right: 14px;
    width: 28px;
    height: 28px;
    background: transparent;
    color: rgba(255, 255, 255, 0.55);
    border: none;
    border-radius: 6px;
    font-size: 18px;
    line-height: 1;
    cursor: pointer;
  }
  .close:hover {
    color: #ffffff;
    background: rgba(255, 255, 255, 0.12);
  }
  .dialog__wrap {
    position: relative;
  }
`

function removeStrayModals(): void {
  document.querySelectorAll(`[${HOST_ATTR}]`).forEach((node) => {
    node.remove()
  })
}

/**
 * Renders the placeholder confirm modal and resolves with the user's
 * choice. If a modal is already open, resolves immediately with
 * `'cancel'` without opening a duplicate — the document-flow
 * orchestrator relies on this to drop a second file event that fires
 * while the first modal is unresolved.
 */
export function showDocumentModal(opts: DocumentModalOptions): Promise<DocumentModalOutcome> {
  if (openModalHost !== null) return Promise.resolve('cancel')

  const mount = document.body ?? document.documentElement
  if (mount === null) return Promise.resolve('cancel')

  return new Promise<DocumentModalOutcome>((resolve) => {
    removeStrayModals()

    const host = document.createElement('div')
    host.setAttribute(HOST_ATTR, '')
    const shadow = host.attachShadow({ mode: 'closed' })

    const style = document.createElement('style')
    style.textContent = STYLES

    const backdrop = document.createElement('div')
    backdrop.className = 'backdrop'

    const wrap = document.createElement('div')
    wrap.className = 'dialog__wrap'

    const dialog = document.createElement('div')
    dialog.className = 'dialog'
    dialog.setAttribute('role', 'dialog')
    dialog.setAttribute('aria-modal', 'true')
    dialog.setAttribute('aria-labelledby', 'ai-leak-guard-document-heading')
    dialog.setAttribute('tabindex', '-1')

    const heading = document.createElement('div')
    heading.className = 'heading'
    heading.id = 'ai-leak-guard-document-heading'
    const noun = opts.fileCount === 1 ? 'file' : 'files'
    heading.innerHTML = `<span class="heading__icon" aria-hidden="true">📎</span><span>${opts.fileCount} ${noun} intercepted before upload</span>`

    const body = document.createElement('div')
    body.className = 'body'
    body.textContent =
      'AI Leak Guard is holding this upload. Content inspection for documents lands in a later release — for now you can release the file as-is or cancel the upload.'

    const actions = document.createElement('div')
    actions.className = 'actions'

    const cancelBtn = document.createElement('button')
    cancelBtn.type = 'button'
    cancelBtn.className = 'btn btn--secondary'
    cancelBtn.textContent = 'Cancel'

    const uploadBtn = document.createElement('button')
    uploadBtn.type = 'button'
    uploadBtn.className = 'btn btn--primary'
    uploadBtn.textContent = 'Upload anyway'

    actions.append(cancelBtn, uploadBtn)

    const close = document.createElement('button')
    close.type = 'button'
    close.className = 'close'
    close.setAttribute('aria-label', 'Cancel')
    close.title = 'Cancel'
    close.textContent = '×'

    dialog.append(heading, body, actions)
    wrap.append(close, dialog)
    backdrop.appendChild(wrap)
    shadow.append(style, backdrop)

    // Focus trap across primary → secondary → close, same order as
    // preview-modal so a11y is consistent across V1.1 and V1.2.
    const focusables: HTMLButtonElement[] = [uploadBtn, cancelBtn, close]

    let settled = false
    const finalize = (outcome: DocumentModalOutcome): void => {
      if (settled) return
      settled = true
      document.removeEventListener('keydown', keyHandler, true)
      host.remove()
      openModalHost = null
      activeCancel = null
      if (opts.opener !== null && opts.opener.isConnected) {
        try {
          ;(opts.opener as HTMLElement).focus?.()
        } catch {
          // Ignore focus failures — the modal is already gone.
        }
      }
      resolve(outcome)
    }

    const keyHandler = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        finalize('cancel')
        return
      }
      if (event.key === 'Enter') {
        const activeInShadow = shadow.activeElement as HTMLElement | null
        if (activeInShadow === uploadBtn) {
          event.preventDefault()
          event.stopPropagation()
          finalize('upload-anyway')
        } else if (activeInShadow === cancelBtn || activeInShadow === close) {
          // Let the browser's default activate the focused button; still
          // stop propagation so the host page's Enter-to-send handler
          // (ChatGPT / Claude etc.) does not fire while the modal is up.
          event.stopPropagation()
        } else {
          event.preventDefault()
          event.stopPropagation()
          uploadBtn.focus()
        }
        return
      }
      if (event.key === 'Tab') {
        const activeInShadow = shadow.activeElement as HTMLElement | null
        const index = focusables.indexOf(activeInShadow as HTMLButtonElement)
        if (index === -1) {
          event.preventDefault()
          focusables[0].focus()
          return
        }
        const nextIndex = event.shiftKey
          ? (index - 1 + focusables.length) % focusables.length
          : (index + 1) % focusables.length
        event.preventDefault()
        focusables[nextIndex].focus()
      }
    }

    document.addEventListener('keydown', keyHandler, true)

    uploadBtn.addEventListener('click', () => {
      finalize('upload-anyway')
    })
    cancelBtn.addEventListener('click', () => {
      finalize('cancel')
    })
    close.addEventListener('click', () => {
      finalize('cancel')
    })
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) {
        finalize('cancel')
      }
    })

    mount.appendChild(host)
    openModalHost = host
    activeCancel = () => {
      finalize('cancel')
    }

    // Focus the primary button so Enter naturally activates upload-anyway.
    uploadBtn.focus()
  })
}

/**
 * Test-only: unwinds any modal state left behind by an aborted test.
 * Runs the full cancel teardown so no document-level keydown listener
 * leaks between tests.
 */
export function __resetDocumentModalForTests(): void {
  if (activeCancel !== null) activeCancel()
  removeStrayModals()
}
