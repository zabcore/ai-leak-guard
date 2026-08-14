// Preview-before-send modal. Rendered inside a closed Shadow DOM so host-page
// styles cannot leak in or out. The modal is a promise-returning primitive —
// `showPreviewModal({...})` opens it and resolves with the user's choice
// ('protected' | 'as-is' | 'cancel'). The paste flow acts on that outcome and
// stays free of any DOM-specific state.

import type { PreviewSummary } from './preview-flow'

export type PreviewOutcome = 'protected' | 'as-is' | 'cancel'

export interface PreviewModalOptions {
  readonly summary: PreviewSummary
  /**
   * The element that had focus when the paste was intercepted. Focus is
   * returned here when the modal closes (regardless of outcome) so the input
   * behaves as if the paste never happened on cancel — and is ready for the
   * next keystroke on protected / as-is.
   */
  readonly opener: Element | null
}

const HOST_ATTR = 'data-ai-leak-guard-preview-modal'

let openModalHost: HTMLElement | null = null
// Reset callback installed by the active modal. Runs full teardown (removes
// the document keydown listener, unmounts the host, resolves the promise as
// 'cancel'). Used by `__resetPreviewModalForTests` so an aborted test cannot
// leave a stale document-level listener that would fire against a modal
// created by a later test.
let activeCancel: (() => void) | null = null

/** True while a preview modal is on screen. Used by the content script to
 * ignore a second paste event that arrives before the first modal resolves. */
export function isPreviewModalOpen(): boolean {
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
    max-width: 640px;
    width: 100%;
    max-height: min(80vh, 720px);
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
  .list {
    padding: 6px 20px 12px;
    font-size: 13px;
    color: rgba(255, 255, 255, 0.78);
    line-height: 1.5;
  }
  .list__item + .list__item::before {
    content: ' · ';
    color: rgba(255, 255, 255, 0.4);
  }
  .preview {
    margin: 0 20px 12px;
    padding: 12px 14px;
    background: #14151a;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 8px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
    line-height: 1.5;
    white-space: pre-wrap;
    overflow: auto;
    max-height: 260px;
    color: #d0d0d5;
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
    background: #22c55e;
    color: #0b1a10;
    border-color: #22c55e;
  }
  .btn--primary:hover {
    background: #16a34a;
    border-color: #16a34a;
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

function formatItem(count: number, label: string): string {
  return `${count} ${label}${count === 1 ? '' : 's'}`
}

function removeStrayModals(): void {
  document.querySelectorAll(`[${HOST_ATTR}]`).forEach((node) => {
    node.remove()
  })
}

/**
 * Renders the preview modal and resolves with the user's choice.
 *
 * If a modal is already open, the call resolves immediately with `'cancel'`
 * without opening a second one — the paste flow uses this to drop a second
 * paste event that arrives while the first modal is unresolved.
 */
export function showPreviewModal(opts: PreviewModalOptions): Promise<PreviewOutcome> {
  if (openModalHost !== null) return Promise.resolve('cancel')

  const mount = document.body ?? document.documentElement
  if (mount === null) return Promise.resolve('cancel')

  return new Promise<PreviewOutcome>((resolve) => {
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
    dialog.setAttribute('aria-labelledby', 'ai-leak-guard-preview-heading')
    dialog.setAttribute('tabindex', '-1')

    const heading = document.createElement('div')
    heading.className = 'heading'
    heading.id = 'ai-leak-guard-preview-heading'
    const noun = opts.summary.count === 1 ? 'item' : 'items'
    heading.innerHTML = `<span class="heading__icon" aria-hidden="true">🛡</span><span>${opts.summary.count} sensitive ${noun} detected</span>`

    const list = document.createElement('div')
    list.className = 'list'
    list.setAttribute('aria-label', 'What will be masked')
    for (const group of opts.summary.groups) {
      const item = document.createElement('span')
      item.className = 'list__item'
      item.textContent = formatItem(group.count, group.label)
      list.appendChild(item)
    }

    const preview = document.createElement('pre')
    preview.className = 'preview'
    preview.setAttribute('aria-label', 'Redacted preview')
    preview.textContent = opts.summary.protectedText

    const actions = document.createElement('div')
    actions.className = 'actions'

    const asIsBtn = document.createElement('button')
    asIsBtn.type = 'button'
    asIsBtn.className = 'btn btn--secondary'
    asIsBtn.textContent = 'Paste as-is'

    const protectedBtn = document.createElement('button')
    protectedBtn.type = 'button'
    protectedBtn.className = 'btn btn--primary'
    protectedBtn.textContent = 'Paste protected version'

    actions.append(asIsBtn, protectedBtn)

    const close = document.createElement('button')
    close.type = 'button'
    close.className = 'close'
    close.setAttribute('aria-label', 'Cancel')
    close.title = 'Cancel'
    close.textContent = '×'

    dialog.append(heading, list, preview, actions)
    wrap.append(close, dialog)
    backdrop.appendChild(wrap)
    shadow.append(style, backdrop)

    // Focus trap: cycle Tab / Shift+Tab across the modal's focusable elements.
    // We list them explicitly rather than querying because there are only
    // three and the order matters (primary is the default focus target).
    const focusables: HTMLButtonElement[] = [protectedBtn, asIsBtn, close]

    let settled = false
    const finalize = (outcome: PreviewOutcome): void => {
      if (settled) return
      settled = true
      document.removeEventListener('keydown', keyHandler, true)
      host.remove()
      openModalHost = null
      activeCancel = null
      // Return focus to the paste target so the input is ready for the next
      // keystroke. Guard against the opener having been removed from the DOM
      // while the modal was open.
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
        // Enter activates the primary action UNLESS focus is on the secondary
        // or close button — in that case the browser's default (activate the
        // focused button) is exactly what the user asked for. This mirrors
        // native dialog conventions and avoids a jarring "Enter always
        // protects" when the user has deliberately Tab'd to a different button.
        //
        // In BOTH branches we stopPropagation so the Enter never reaches the
        // host page (ChatGPT / Claude / etc. would otherwise send the prompt
        // in the middle of the user's sensitive-paste decision). Only the
        // primary path also preventDefaults; the secondary/close path leaves
        // the default action alone so the focused button still activates.
        const activeInShadow = shadow.activeElement as HTMLElement | null
        if (activeInShadow !== asIsBtn && activeInShadow !== close) {
          event.preventDefault()
          event.stopPropagation()
          finalize('protected')
        } else {
          event.stopPropagation()
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

    // Capture-phase keydown so the modal beats the host page to Escape/Enter
    // (e.g. Claude/ChatGPT's own Enter-to-send handler).
    document.addEventListener('keydown', keyHandler, true)

    protectedBtn.addEventListener('click', () => {
      finalize('protected')
    })
    asIsBtn.addEventListener('click', () => {
      finalize('as-is')
    })
    close.addEventListener('click', () => {
      finalize('cancel')
    })
    backdrop.addEventListener('click', (event) => {
      // Only cancel when the click landed on the backdrop itself, not on the
      // dialog or one of its descendants.
      if (event.target === backdrop) {
        finalize('cancel')
      }
    })

    mount.appendChild(host)
    openModalHost = host
    // Register the full teardown so `__resetPreviewModalForTests` can undo
    // everything a live modal installed — most importantly the document-level
    // keydown listener, which would otherwise linger past the test and could
    // fire against a modal created by a later test.
    activeCancel = () => {
      finalize('cancel')
    }

    // Focus the primary button so Enter naturally activates protected.
    protectedBtn.focus()
  })
}

/**
 * Test-only: unwinds any modal state left behind by an aborted test. Runs
 * the same teardown the live modal would run on cancel — removes the
 * document keydown listener, unmounts the host, resolves the pending
 * promise as 'cancel', and clears module state. Never called by production.
 */
export function __resetPreviewModalForTests(): void {
  if (activeCancel !== null) {
    activeCancel()
  }
  removeStrayModals()
}
