// V1.3 M2 — ChatGPT submit-scan adapter (first live "Protection at
// Send" site). Implements the M1 `SubmitAdapter` contract; the M1
// core owns the state machine and the decision/resume sequencing.
//
// GROUND TRUTH from the M0 live run on chatgpt.com (verified):
//   • Resume works: an UNTRUSTED `sendButton.click()` submits — the
//     app does not check `event.isTrusted`. Primary resume =
//     `sendButton.click()`, resolved fresh at resume time.
//   • The send button (`button[data-testid="send-button"]`,
//     `#composer-submit-button` on some builds) exists/enabled only
//     once the composer has text, and swaps to a Stop button while
//     streaming — so it MUST be resolved at resume time, never cached
//     at block time.
//   • Composer is a ProseMirror contenteditable (`#prompt-textarea`,
//     `role="textbox"`); Enter is a ProseMirror keymap binding;
//     capture-phase on `window` fires before the site handler.
//
// WHAT THIS ADAPTER DOES
//   attach(core): registers a capture-phase `keydown` and a
//     capture-phase `click` on `window`. On a REAL send intent it
//     `preventDefault()` + `stopImmediatePropagation()` +
//     `stopPropagation()` (synchronously, before the site's handler
//     can run), stashes the event-time composer, and calls
//     `core.handleSendIntent(this, intent)`.
//   readComposerText(): reads the ProseMirror composer resolved at
//     event time (never a stale cached reference — the subtree
//     re-mounts on route/AB changes), through the SAME boundary walk
//     the EMR paste fix uses (`stripHtmlToText`) so multi-paragraph
//     ProseMirror doesn't glue `<p>`s into one line.
//   resume(): resolves the send button FRESH, then
//     `sendButton.click()` — SYNCHRONOUSLY, so it lands inside the
//     user-activation window of the proceed-click (no `await`
//     anywhere between the user's choice and this call). Falls back
//     to a re-dispatched Enter `KeyboardEvent` when the button is
//     absent/disabled. Returns submitted / failed / unknown from a
//     synchronous post-check.
//
// A REAL SEND INTENT is: `Enter` with `!shiftKey && !isComposing &&
// keyCode !== 229`. Shift+Enter is a newline — never a send. IME
// composition (`isComposing` or `keyCode 229`) is NEVER intercepted;
// getting that wrong breaks CJK entry, so it is guarded twice. A
// click whose composed path crosses the send button is the same
// intent.

import type { ResumeResult, SubmitAdapter, SubmitCore, SendIntent } from '../submit-core'
import { stripHtmlToText } from '../../clipboard-text'
import { isDocumentModalOpen } from '../../document-modal'
import { isPreviewModalOpen } from '../../preview-modal'

/** Composer selectors, most-specific first. Resolved fresh every event. */
const COMPOSER_SELECTOR =
  '#prompt-textarea, [contenteditable="true"][role="textbox"], textarea[data-testid="prompt-textarea"]'

/**
 * Send-button selectors, most-specific first. Deliberately matches
 * ONLY the send button, never the Stop button (`stop-button`) it
 * swaps to while streaming — a click on Stop is not a send.
 */
const SEND_BUTTON_SELECTOR =
  'button[data-testid="send-button"], #composer-submit-button, button[aria-label="Send prompt"]'

/** Stable composer key — ChatGPT has a single composer per tab. */
const COMPOSER_KEY = 'chatgpt-composer'

export interface ChatGptSubmitAdapterOptions {
  /**
   * Master on/off (the extension's `enabled` toggle). Checked
   * synchronously per event so a disabled extension never blocks a
   * send. Defaults to always-on for standalone construction/tests.
   */
  readonly isMasterEnabled?: () => boolean
  /**
   * Compile-time/runtime submit-protection flag. Checked
   * synchronously per event; when false the adapter is a strict
   * no-op (native send proceeds untouched). Defaults to always-on
   * so unit tests exercise the intent path without the flag module.
   */
  readonly isFlagEnabled?: () => boolean
}

export class ChatGptSubmitAdapter implements SubmitAdapter {
  readonly id = 'chatgpt'

  private core: SubmitCore | null = null
  private readonly isMasterEnabled: () => boolean
  private readonly isFlagEnabled: () => boolean

  /**
   * Composer element resolved at THIS send's event time. Held only
   * for the duration of the in-flight send (the core reads it in a
   * microtask, then again at resume), cleared on completion. Not a
   * cross-intent cache: re-resolved fresh on every send event.
   */
  private pendingComposer: HTMLElement | null = null
  private pendingOpener: Element | null = null

  /**
   * True only while THIS adapter is performing a resume (a
   * synchronous `sendButton.click()` or a re-dispatched Enter). Our
   * own capture-phase listeners would otherwise re-intercept the
   * synthetic click/keydown we just fired — an infinite hold loop
   * where the real send never reaches the site. The flag makes the
   * listeners ignore our own events. Synchronous set/reset: the
   * synthetic event dispatches (and our listener runs) inline within
   * `click()` / `dispatchEvent()`, all inside the try/finally.
   */
  private resuming = false

  constructor(opts: ChatGptSubmitAdapterOptions = {}) {
    this.isMasterEnabled = opts.isMasterEnabled ?? (() => true)
    this.isFlagEnabled = opts.isFlagEnabled ?? (() => true)
  }

  attach(core: SubmitCore): void {
    this.core = core
    // Capture phase on window: outermost target in the DOM event
    // flow, so we run before ChatGPT's ProseMirror keymap and its
    // send-button onClick. `run_at: document_start` + capture also
    // wins registration-order ties on the same node.
    window.addEventListener('keydown', this.onKeydown, true)
    window.addEventListener('click', this.onClick, true)
  }

  /** Test-only: undo `attach` so a jsdom test doesn't leak listeners. */
  detach(): void {
    window.removeEventListener('keydown', this.onKeydown, true)
    window.removeEventListener('click', this.onClick, true)
    this.core = null
    this.pendingComposer = null
    this.pendingOpener = null
  }

  /** The composer element focus should return to after the modal closes. */
  getCurrentOpener(): Element | null {
    return this.pendingOpener
  }

  // ── SubmitAdapter surface the core calls ──

  readComposerText(): string {
    const el = this.currentComposer()
    if (el === null) return ''
    // Textarea/input path (defensive — ChatGPT is contenteditable).
    const value = (el as HTMLTextAreaElement).value
    if (typeof value === 'string' && el.tagName === 'TEXTAREA') return value
    // ProseMirror contenteditable → reuse the EMR paste-fix walk so
    // `<p>`/`<br>` boundaries become separators (no glued paragraphs)
    // and script/style never leak into the detector input.
    return stripHtmlToText(el.innerHTML)
  }

  resume(): ResumeResult {
    const el = this.currentComposer()
    const before = el === null ? '' : this.readComposerText()
    const button = resolveSendButton()

    // Primary: click the site's own send button, resolved fresh.
    // MUST be synchronous — inside the proceed-click activation
    // window. No await before or after. `this.resuming` makes our
    // own capture-phase click listener ignore this synthetic click.
    if (button !== null && isButtonUsable(button)) {
      this.resuming = true
      try {
        button.click()
      } finally {
        this.resuming = false
      }
      return this.postCheck(el, before, /* attempted */ true)
    }

    // Fallback: re-dispatch an Enter keydown on the composer. M0
    // confirmed the app acts on an untrusted KeyboardEvent too.
    // Same re-entrancy guard so our own keydown listener ignores it.
    if (el !== null) {
      this.resuming = true
      let dispatched: boolean
      try {
        dispatched = dispatchEnter(el)
      } finally {
        this.resuming = false
      }
      return this.postCheck(el, before, dispatched)
    }

    // Nothing to act on — no usable button and no composer. This is
    // the only genuine, synchronously-certain failure (feeds the
    // core's kill-switch counter).
    return 'failed'
  }

  // ── send-intent listeners ──

  private readonly onKeydown = (event: KeyboardEvent): void => {
    if (event.key !== 'Enter') return
    if (!this.shouldIntercept()) return
    // Never intercept a newline or an IME-composition Enter. The IME
    // guard is doubled (`isComposing` AND legacy `keyCode === 229`)
    // because some builds/engines only set one; missing either
    // breaks CJK candidate confirmation.
    if (event.shiftKey) return
    if (event.isComposing || event.keyCode === 229) return
    const composer = resolveComposerFrom(event)
    if (composer === null) return
    // Only intercept when the event actually targets the composer —
    // a global Enter elsewhere on the page is not a send.
    if (!eventTargetsComposer(event, composer)) return
    this.intercept(event, composer)
  }

  private readonly onClick = (event: MouseEvent): void => {
    if (!this.shouldIntercept()) return
    const button = sendButtonInPath(event)
    if (button === null) return
    // A disabled send button click is a no-op for the site too —
    // don't intercept it (nothing to send yet).
    if (!isButtonUsable(button)) return
    const composer = resolveComposerFrom(event)
    if (composer === null) return
    this.intercept(event, composer)
  }

  /**
   * Synchronous gate for whether this adapter may take the send. All
   * three must hold BEFORE we `preventDefault`, so a disabled flag /
   * toggle / kill-switch always leaves the site's native send
   * working.
   */
  private shouldIntercept(): boolean {
    // Never intercept the synthetic click/keydown we ourselves fire
    // during resume() — that would loop and the real send would
    // never land.
    if (this.resuming) return false
    if (this.core === null) return false
    if (!this.isFlagEnabled()) return false
    if (!this.isMasterEnabled()) return false
    if (this.core.isAdapterDisabled(this.id)) return false
    // While a warning modal is on screen, let the modal own the keys
    // (its own capture-phase handler manages Enter/Escape). Bailing
    // here — no preventDefault, no stop — lets the event reach it.
    if (isAnyGuardModalOpen()) return false
    return true
  }

  private intercept(event: Event, composer: HTMLElement): void {
    // Block the native send synchronously, before the site handler.
    event.preventDefault()
    event.stopImmediatePropagation()
    event.stopPropagation()
    this.pendingComposer = composer
    this.pendingOpener = composer
    const intent: SendIntent = { composerKey: COMPOSER_KEY }
    const core = this.core
    if (core === null) return
    void core
      .handleSendIntent(this, intent)
      .catch(() => {
        // The core never rejects, but guard anyway — a throw here
        // must not leave the page wedged.
      })
      .finally(() => {
        this.pendingComposer = null
        this.pendingOpener = null
      })
  }

  // ── helpers ──

  /** Prefer the event-time element; fall back to a fresh query if it detached. */
  private currentComposer(): HTMLElement | null {
    if (this.pendingComposer !== null && this.pendingComposer.isConnected) {
      return this.pendingComposer
    }
    return queryComposer()
  }

  /**
   * Synchronous post-check after a resume attempt.
   *   • couldn't attempt at all           → 'failed'
   *   • composer detached after the action → 'submitted'
   *   • composer text cleared / changed    → 'submitted'
   *   • attempted but text unchanged       → 'unknown' (ProseMirror/
   *     React may clear on a later tick; NEVER report 'failed' on a
   *     completed action, or a successful send would spuriously trip
   *     the kill switch)
   *
   * The signal is the COMPOSER, not the send button: a button that
   * is absent/disabled is only meaningful if it changed as a result
   * of our action, which we can't attribute synchronously — the
   * fallback path has no button at all. Composer text change /
   * detachment is the attributable evidence.
   */
  private postCheck(el: HTMLElement | null, before: string, attempted: boolean): ResumeResult {
    if (!attempted) return 'failed'
    if (el === null || !el.isConnected) return 'submitted'
    const after = this.readComposerText()
    if (before.trim().length > 0 && after !== before) return 'submitted'
    // Acted on a live composer but the text is still there — may be
    // an async clear. Race-safe: not confirmed, not failed.
    return 'unknown'
  }
}

// ─── free DOM helpers (module-scoped, no per-instance state) ─────────

function queryComposer(): HTMLElement | null {
  return document.querySelector<HTMLElement>(COMPOSER_SELECTOR)
}

/** Resolve the composer from the event's composed path, else a fresh query. */
function resolveComposerFrom(event: Event): HTMLElement | null {
  const path = typeof event.composedPath === 'function' ? event.composedPath() : []
  for (const node of path) {
    if (node instanceof Element && node.matches(COMPOSER_SELECTOR)) {
      return node as HTMLElement
    }
  }
  return queryComposer()
}

function eventTargetsComposer(event: Event, composer: HTMLElement): boolean {
  const path = typeof event.composedPath === 'function' ? event.composedPath() : []
  if (path.includes(composer)) return true
  const target = event.target
  return target instanceof Node && (target === composer || composer.contains(target))
}

function resolveSendButton(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(SEND_BUTTON_SELECTOR)
}

function sendButtonInPath(event: Event): HTMLButtonElement | null {
  const path = typeof event.composedPath === 'function' ? event.composedPath() : []
  for (const node of path) {
    if (node instanceof Element && node.matches(SEND_BUTTON_SELECTOR)) {
      return node as HTMLButtonElement
    }
  }
  return null
}

function isButtonUsable(button: HTMLButtonElement): boolean {
  if (button.disabled) return false
  if (button.getAttribute('aria-disabled') === 'true') return false
  return true
}

/**
 * Re-dispatch an Enter keydown on the composer as the fallback
 * resume. Chrome honours `keyCode`/`which` from the init dict; we
 * also define them defensively for engines that don't. Returns the
 * `dispatchEvent` result (false if a handler cancelled it — which
 * for a send binding still means it was acted upon).
 */
function dispatchEnter(el: HTMLElement): boolean {
  const init: KeyboardEventInit = {
    key: 'Enter',
    code: 'Enter',
    keyCode: 13,
    which: 13,
    bubbles: true,
    cancelable: true,
    composed: true,
  } as KeyboardEventInit
  let event: KeyboardEvent
  try {
    event = new KeyboardEvent('keydown', init)
    if (event.keyCode !== 13) Object.defineProperty(event, 'keyCode', { get: () => 13 })
    if (event.which !== 13) Object.defineProperty(event, 'which', { get: () => 13 })
  } catch {
    return false
  }
  try {
    ;(el as HTMLElement).focus?.()
  } catch {
    // focus is best-effort
  }
  // `dispatchEvent` returns false when a listener called
  // preventDefault — for an Enter-to-send binding that is the normal
  // "the site handled it" signal, so a canceled event counts as an
  // attempt.
  el.dispatchEvent(event)
  return true
}

/**
 * True while any AI Leak Guard warning modal is on screen. Imported
 * lazily to avoid a static cycle and to keep this module free of
 * paste-flow imports. Both modal singletons expose an `isOpen`
 * predicate; either being up means the keys belong to the modal.
 */
function isAnyGuardModalOpen(): boolean {
  return isDocumentModalOpen() || isPreviewModalOpen()
}
