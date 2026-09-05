// V1.2 A4 document-protection warning modal.
//
// The A1 placeholder is gone — this modal now consumes A3's
// `AggregateScanResult` and renders the real warning UX:
//
//   scanning   → cancellable "Checking this file…" spinner
//   sensitive  → "N sensitive items found" + friendly category chips +
//                critical-or-high emphasis; primary is [Upload anyway]
//   unable     → honest "we couldn't read this file to check it" copy
//                with a reason-aware sub-line
//
// Product invariant: documents warn, never block. Primary stays
// [Upload anyway]; the modal is a heads-up. Clean files never reach
// the modal at all (the decision helper resolves `'upload-anyway'`
// without opening one).
//
// Metadata-only. The modal renders counts, categories, and severity —
// NEVER the raw `Finding.value`. A dedicated component test asserts
// the matched string is absent from the modal's shadow DOM (mirrors
// A5's metadata-only event-log discipline and the "no clean-copy of
// documents in V1.2" scope).
//
// Reuses the V1.1 preview-modal patterns unchanged: closed Shadow
// DOM (host-page CSS cannot leak in or read out), focus trap over
// primary → secondary → close, Escape / × / backdrop all cancel,
// focus returns to the opener on close, and a document-level
// capture-phase keydown so the host page's Enter-to-send handler
// (ChatGPT / Claude etc.) never fires while the modal is up.

import { DetectorCategory } from '../detector/types'
import type { ExtractionReason } from './extraction/extract'

export type DocumentModalOutcome = 'upload-anyway' | 'cancel'

/**
 * Copy overrides so the same modal component can front the V1.2
 * document/upload surface AND the V1.3 M2 submit surface without a
 * second component (spec: reuse the modal, don't build a new one).
 * Every field defaults to the original document/upload copy, so
 * existing callers (`document-decision.ts`) that pass nothing get
 * byte-identical text — the document-modal test suite is unchanged.
 *
 *   surface 'file'    → "Checking this file…", "found in this file",
 *                       "before upload", [Upload anyway] / [Cancel]
 *   surface 'message' → "Checking this message…", "found in this
 *                       message", "before sending", [Proceed anyway]
 *                       / [Return to editing]
 */
export interface DocumentModalCopy {
  readonly surface?: 'file' | 'message'
  readonly primaryLabel?: string
  readonly cancelLabel?: string
}

export interface SensitiveViewOpts {
  readonly fileCount: number
  readonly totalMaskable: number
  readonly categories: readonly DetectorCategory[]
  readonly hasCriticalOrHigh: boolean
  // ── V1.3 M4 (additive; all optional). Present only on the combined
  //    send surface so a message carrying both typed PHI and a flagged
  //    attachment reads as ONE warning. Existing 'file' and 'message'
  //    callers pass none of these and get byte-identical copy. ──
  /** Number of attached files considered at send (>0 → attachment copy). */
  readonly attachmentCount?: number
  /** True when the typed message itself carried flagged text. */
  readonly messageHasSensitiveText?: boolean
  /** True when one of the attachments couldn't be inspected. */
  readonly attachmentUnableToInspect?: boolean
}

export interface UnableViewOpts {
  readonly fileCount: number
  /** Chosen from the first unable-to-inspect file. Drives the honest
   *  sub-line copy (encrypted / no text layer / too large / …). */
  readonly reason?: ExtractionReason
}

/**
 * Programmatic controller over one open modal. The decision helper
 * opens the modal in the `scanning` state, then transitions it to
 * `sensitive` / `unable` when inspection resolves — or calls `close()`
 * when the aggregate is clean.
 *
 * `outcome` resolves once when the user (or `close()`) picks an
 * outcome; subsequent calls are no-ops.
 */
export interface DocumentModalController {
  readonly outcome: Promise<DocumentModalOutcome>
  showSensitive(opts: SensitiveViewOpts): void
  showUnable(opts: UnableViewOpts): void
  close(outcome: DocumentModalOutcome): void
}

const HOST_ATTR = 'data-ai-leak-guard-document-modal'

let openModalHost: HTMLElement | null = null
let openModalShadow: ShadowRoot | null = null
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
    max-width: 560px;
    width: 100%;
    max-height: min(70vh, 560px);
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
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 4px 20px 14px;
  }
  .chip {
    display: inline-block;
    padding: 3px 10px;
    font-size: 12px;
    line-height: 1.4;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.08);
    color: rgba(255, 255, 255, 0.9);
    border: 1px solid rgba(255, 255, 255, 0.12);
  }
  .chip--critical {
    background: rgba(245, 158, 11, 0.18);
    border-color: rgba(245, 158, 11, 0.45);
    color: #fbbf24;
  }
  .severity {
    padding: 0 20px 12px;
    font-size: 12px;
    color: #fbbf24;
    font-weight: 600;
  }
  .scanning {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 8px 20px 20px;
    font-size: 13px;
    color: rgba(255, 255, 255, 0.85);
  }
  .scanning__label {
    display: block;
  }
  /*
   * Indeterminate progress bar. We deliberately don't show a fake
   * percentage — extraction time depends on the file and the parser,
   * and any bar that "fills up" would be dishonest. A moving indigo
   * strip traversing a dim track communicates activity without
   * implying progress state.
   */
  .progress {
    position: relative;
    height: 4px;
    width: 100%;
    overflow: hidden;
    background: rgba(255, 255, 255, 0.10);
    border-radius: 999px;
  }
  .progress__bar {
    position: absolute;
    top: 0;
    left: 0;
    height: 100%;
    width: 35%;
    background: linear-gradient(
      90deg,
      rgba(125, 211, 252, 0),
      rgba(125, 211, 252, 0.95) 50%,
      rgba(125, 211, 252, 0) 100%
    );
    border-radius: 999px;
    animation: alg-progress 1.4s ease-in-out infinite;
    will-change: transform;
  }
  /* -35% start → 100% end keeps the strip fully off-screen at both
     ends so the eye never sees it stop against the track edge. */
  @keyframes alg-progress {
    0%   { transform: translateX(-100%); }
    100% { transform: translateX(285%); }
  }
  @media (prefers-reduced-motion: reduce) {
    /* Reduced-motion fallback: static, centered, translucent bar
       (no animation, no transform). Still reads as "something is
       happening" alongside the aria-busy state below. */
    .progress__bar {
      animation: none;
      transform: none;
      left: 30%;
      width: 40%;
      background: rgba(125, 211, 252, 0.55);
    }
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

// Friendly, non-technical chip labels for the sensitive view. Kept
// centralised so A5's event log can reuse the same phrasing if we
// ever expose it there. `clinical_context` is included for
// completeness even though `isMaskable` filters it out — a future
// signal that reaches the maskable set shouldn't render as a raw
// enum key.
const CATEGORY_LABELS: Record<DetectorCategory, string> = {
  [DetectorCategory.HEALTHCARE_PATIENT_ID]: 'Patient identifiers (MRN)',
  [DetectorCategory.IDENTITY]: 'Personal identity',
  [DetectorCategory.GOVERNMENT_FINANCIAL]: 'SSN / financial',
  [DetectorCategory.PROVIDER_ID]: 'Provider ID (NPI)',
  [DetectorCategory.DEVELOPER_CREDENTIAL]: 'Credentials',
  [DetectorCategory.CLINICAL_CONTEXT]: 'Clinical context',
}

export function friendlyCategoryLabel(cat: DetectorCategory): string {
  return CATEGORY_LABELS[cat] ?? cat
}

// Reason-aware sub-line for the unable_to_inspect view. Honest about
// WHY we couldn't read it so the user can decide whether the file
// really is safe to send.
function unableReasonLine(reason: ExtractionReason | undefined): string {
  switch (reason) {
    case 'encrypted':
      return "This file is password-protected, so we couldn't read it to check its contents."
    case 'no-text-layer':
      return "This file has no readable text layer — it looks like a scanned image or contains only pictures, so we couldn't check its contents."
    case 'too-large':
    case 'too-large-to-scan':
      return "This file is too large to inspect, so we couldn't check its contents."
    case 'timeout':
      return "Reading this file took too long, so we couldn't finish checking it."
    case 'unsupported-type':
      return "This file type isn't one we can read, so we couldn't check its contents."
    case 'parse-error':
    case 'scan-error':
      return "We hit an error while reading this file, so we couldn't check its contents."
    case 'empty':
      return 'This file looked empty when we tried to read it, so there was nothing to check.'
    default:
      return "We couldn't read this file to check its contents."
  }
}

function removeStrayModals(): void {
  document.querySelectorAll(`[${HOST_ATTR}]`).forEach((node) => {
    node.remove()
  })
}

/**
 * Open the modal in the `scanning` state and return a controller so
 * the caller can transition to `sensitive` / `unable` when
 * `inspectFiles` resolves — or `close('upload-anyway')` when the
 * aggregate is clean (the decision helper's flicker-avoidance path).
 *
 * If a modal is already open, resolves the returned outcome
 * immediately with `'cancel'`; the caller drops the second concurrent
 * hold, same policy as V1.1 paste and A1.
 */
export function openDocumentModal(opts: {
  readonly opener: Element | null
  readonly copy?: DocumentModalCopy
}): DocumentModalController {
  const surface = opts.copy?.surface ?? 'file'
  const primaryLabel = opts.copy?.primaryLabel ?? 'Upload anyway'
  const cancelLabel = opts.copy?.cancelLabel ?? 'Cancel'
  if (openModalHost !== null) {
    const resolved = Promise.resolve<DocumentModalOutcome>('cancel')
    const noop = (): void => {}
    return { outcome: resolved, showSensitive: noop, showUnable: noop, close: noop }
  }

  const mount = document.body ?? document.documentElement
  if (mount === null) {
    const resolved = Promise.resolve<DocumentModalOutcome>('cancel')
    const noop = (): void => {}
    return { outcome: resolved, showSensitive: noop, showUnable: noop, close: noop }
  }

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
  const headingIcon = document.createElement('span')
  headingIcon.className = 'heading__icon'
  headingIcon.setAttribute('aria-hidden', 'true')
  const headingText = document.createElement('span')
  heading.append(headingIcon, headingText)

  const body = document.createElement('div')
  body.className = 'body'

  const scanning = document.createElement('div')
  scanning.className = 'scanning'
  // role="status" + aria-live=polite lets AT announce the scanning
  // label when the view appears (and again when it transitions to
  // sensitive / unable), without stealing focus away from Cancel.
  // aria-busy=true tells AT that the region is still being populated
  // — pairs with the indeterminate progress bar below.
  scanning.setAttribute('role', 'status')
  scanning.setAttribute('aria-live', 'polite')
  scanning.setAttribute('aria-busy', 'true')
  const scanningText = document.createElement('span')
  scanningText.className = 'scanning__label'
  // Indeterminate progress bar. `aria-hidden` on the visual track
  // keeps AT from double-announcing (the parent status region owns
  // the announcement). Deliberately no `<progress>` element — that
  // implies a knowable value, which we don't have.
  const progress = document.createElement('div')
  progress.className = 'progress'
  progress.setAttribute('aria-hidden', 'true')
  const progressBar = document.createElement('div')
  progressBar.className = 'progress__bar'
  progress.appendChild(progressBar)
  scanning.append(scanningText, progress)

  const severity = document.createElement('div')
  severity.className = 'severity'

  const chips = document.createElement('div')
  chips.className = 'chips'
  chips.setAttribute('aria-label', 'Kinds of sensitive content found')

  const actions = document.createElement('div')
  actions.className = 'actions'

  const cancelBtn = document.createElement('button')
  cancelBtn.type = 'button'
  cancelBtn.className = 'btn btn--secondary'
  cancelBtn.textContent = cancelLabel

  const uploadBtn = document.createElement('button')
  uploadBtn.type = 'button'
  uploadBtn.className = 'btn btn--primary'
  uploadBtn.textContent = primaryLabel
  // Hidden in the scanning view — nothing to upload-anyway to until
  // the scan resolves.
  uploadBtn.hidden = true

  actions.append(cancelBtn, uploadBtn)

  const close = document.createElement('button')
  close.type = 'button'
  close.className = 'close'
  close.setAttribute('aria-label', 'Cancel')
  close.title = 'Cancel'
  close.textContent = '×'

  wrap.append(close, dialog)
  backdrop.appendChild(wrap)
  shadow.append(style, backdrop)

  let mode: 'scanning' | 'sensitive' | 'unable' = 'scanning'

  const applyScanning = (): void => {
    mode = 'scanning'
    headingIcon.textContent = '🔎'
    headingText.textContent =
      surface === 'message' ? 'Checking this message…' : 'Checking this file…'
    body.hidden = true
    severity.hidden = true
    chips.hidden = true
    scanningText.textContent =
      surface === 'message'
        ? 'Inspecting for sensitive content before sending.'
        : 'Inspecting for sensitive content before upload.'
    scanning.hidden = false
    scanning.setAttribute('aria-busy', 'true')
    uploadBtn.hidden = true
    dialog.replaceChildren(heading, scanning, actions)
    // Focus the cancel button so Escape / Enter behaves obviously in
    // the scanning state (there is no primary action yet).
    cancelBtn.focus()
  }

  const applySensitive = (opts: SensitiveViewOpts): void => {
    mode = 'sensitive'
    headingIcon.textContent = '⚠️'
    const itemNoun = opts.totalMaskable === 1 ? 'item' : 'items'
    // V1.3 M4 combined send: the message surface may also carry an
    // attachment. `attachmentCount > 0` switches the heading to name
    // both dimensions (message + its attachment) or just the attachment
    // for a file-only send decision.
    const attachmentCount = opts.attachmentCount ?? 0
    if (surface === 'message' && attachmentCount > 0) {
      const attachNoun = attachmentCount === 1 ? 'attachment' : 'attachments'
      headingText.textContent = opts.messageHasSensitiveText
        ? `${opts.totalMaskable} sensitive ${itemNoun} found in this message and its ${attachNoun}`
        : `${opts.totalMaskable} sensitive ${itemNoun} found in this ${attachNoun}`
    } else if (surface === 'message') {
      headingText.textContent = `${opts.totalMaskable} sensitive ${itemNoun} found in this message`
    } else if (opts.fileCount <= 1) {
      headingText.textContent = `${opts.totalMaskable} sensitive ${itemNoun} found in this file`
    } else {
      headingText.textContent = `${opts.totalMaskable} sensitive ${itemNoun} found across ${opts.fileCount} files`
    }
    let bodyText =
      surface === 'message'
        ? 'Review before sending. AI Leak Guard warns you about likely-sensitive content — you decide whether to send it.'
        : 'Review before releasing. AI Leak Guard warns you about likely-sensitive content in uploads — you decide whether to send it.'
    if (opts.attachmentUnableToInspect) {
      // Honest note when an attachment couldn't be read — even if the
      // message text was clean, the send carries an uninspected file.
      bodyText += ' One attachment couldn’t be inspected.'
    }
    body.textContent = bodyText
    body.hidden = false
    severity.textContent = opts.hasCriticalOrHigh ? 'Includes high-severity items.' : ''
    severity.hidden = !opts.hasCriticalOrHigh
    chips.replaceChildren()
    for (const cat of opts.categories) {
      const chip = document.createElement('span')
      chip.className = opts.hasCriticalOrHigh ? 'chip chip--critical' : 'chip'
      chip.textContent = friendlyCategoryLabel(cat)
      chips.appendChild(chip)
    }
    chips.hidden = opts.categories.length === 0
    scanning.hidden = true
    scanning.setAttribute('aria-busy', 'false')
    uploadBtn.hidden = false
    const children: Node[] = [heading, body]
    if (opts.hasCriticalOrHigh) children.push(severity)
    if (opts.categories.length > 0) children.push(chips)
    children.push(actions)
    dialog.replaceChildren(...children)
    // Do NOT auto-focus the release action on transition. A user
    // holding Enter (e.g., trying to send a prompt on ChatGPT) at
    // the moment the scanning view flips to the warning must not
    // accidentally release a sensitive document. Focus the dialog
    // container; the focus trap still reaches [Upload anyway] on
    // the first Tab, so keyboard access is preserved.
    dialog.focus()
  }

  const applyUnable = (opts: UnableViewOpts): void => {
    mode = 'unable'
    headingIcon.textContent = '❓'
    headingText.textContent =
      opts.fileCount <= 1
        ? "We couldn't read this file to check it"
        : "We couldn't read one or more files to check them"
    body.textContent = unableReasonLine(opts.reason)
    body.hidden = false
    severity.hidden = true
    chips.hidden = true
    scanning.hidden = true
    scanning.setAttribute('aria-busy', 'false')
    uploadBtn.hidden = false
    dialog.replaceChildren(heading, body, actions)
    // See the note in `applySensitive`: dialog.focus() (not
    // uploadBtn.focus()) so a held Enter can't release before the
    // user reads the warning.
    dialog.focus()
  }

  // The focus trap cycles primary → secondary → close, matching V1.1
  // preview-modal's order. In the scanning state the primary button
  // is hidden and skipped.
  const focusableList = (): HTMLButtonElement[] => {
    const list: HTMLButtonElement[] = []
    if (!uploadBtn.hidden) list.push(uploadBtn)
    list.push(cancelBtn, close)
    return list
  }

  let settled = false
  const finalize = (outcome: DocumentModalOutcome): void => {
    if (settled) return
    settled = true
    document.removeEventListener('keydown', keyHandler, true)
    host.remove()
    openModalHost = null
    openModalShadow = null
    activeCancel = null
    if (opts.opener !== null && opts.opener.isConnected) {
      try {
        ;(opts.opener as HTMLElement).focus?.()
      } catch {
        // Ignore focus failures — the modal is already gone.
      }
    }
    resolveOutcome(outcome)
  }

  let resolveOutcome!: (outcome: DocumentModalOutcome) => void
  const outcomePromise = new Promise<DocumentModalOutcome>((resolve) => {
    resolveOutcome = resolve
  })

  const keyHandler = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      finalize('cancel')
      return
    }
    if (event.key === 'Enter') {
      const activeInShadow = shadow.activeElement as HTMLElement | null
      if (mode !== 'scanning' && activeInShadow === uploadBtn) {
        event.preventDefault()
        event.stopPropagation()
        finalize('upload-anyway')
      } else if (activeInShadow === cancelBtn || activeInShadow === close) {
        // Let the browser activate the focused button naturally; still
        // stop propagation so the host page's Enter-to-send handler
        // (ChatGPT / Claude etc.) doesn't fire while the modal is up.
        event.stopPropagation()
      } else {
        // Focus escaped (dialog container, non-tabbable, or null).
        // Pull focus back to Cancel — the SAFE default. A previous
        // implementation focused the primary [Upload anyway], which
        // meant a held Enter on the scanning→sensitive transition
        // could release the document before the user read the
        // warning. Keeping cancel as the recovery target makes
        // held-Enter default to "cancel", never "release".
        event.preventDefault()
        event.stopPropagation()
        cancelBtn.focus()
      }
      return
    }
    if (event.key === 'Tab') {
      const list = focusableList()
      const activeInShadow = shadow.activeElement as HTMLElement | null
      const index = list.indexOf(activeInShadow as HTMLButtonElement)
      if (index === -1) {
        event.preventDefault()
        list[0].focus()
        return
      }
      const nextIndex = event.shiftKey
        ? (index - 1 + list.length) % list.length
        : (index + 1) % list.length
      event.preventDefault()
      list[nextIndex].focus()
    }
  }

  document.addEventListener('keydown', keyHandler, true)

  uploadBtn.addEventListener('click', () => {
    if (mode === 'scanning') return
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
  openModalShadow = shadow
  activeCancel = () => {
    finalize('cancel')
  }

  applyScanning()

  return {
    outcome: outcomePromise,
    showSensitive: (viewOpts) => {
      if (settled) return
      applySensitive(viewOpts)
    },
    showUnable: (viewOpts) => {
      if (settled) return
      applyUnable(viewOpts)
    },
    close: (outcome) => {
      finalize(outcome)
    },
  }
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

/**
 * Test-only accessor for the modal's (closed) shadow root. The
 * metadata-only test walks the rendered subtree through this seam to
 * assert that raw `Finding.value` strings never appear.
 *
 * NOTE: this symbol ships in the content-script bundle unconditionally
 * (there is no test-only build step). That is safe here because the
 * content-script module scope is not reachable from page scripts —
 * they cannot import the module or reach `openModalShadow` — so the
 * closed-shadow guarantee against the PAGE is unaffected. It is only
 * "test-only" in the sense that no production code path calls it.
 */
export function __getModalShadowForTests(): ShadowRoot | null {
  return openModalShadow
}
