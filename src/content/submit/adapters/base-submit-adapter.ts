// V1.3 M3 — site-agnostic base for the "Protection at Send" adapters.
//
// M2 shipped this behaviour inline in `chatgpt.ts`. M3 extracts the
// ~entirely site-agnostic parts into this base so ChatGPT, Claude,
// and Gemini share ONE implementation of the tricky bits:
//   • capture-phase `keydown` + `click` interception on `window`
//     (outermost target — runs before React's root-delegated handlers,
//     ProseMirror's keymap, and Angular's listeners),
//   • the send-intent test: Enter with `!shiftKey && !isComposing &&
//     keyCode !== 229` targeting the composer, or a click crossing an
//     enabled send button — with the IME guard DOUBLED (`isComposing`
//     AND legacy `keyCode === 229`; missing either breaks CJK entry),
//   • the `resuming` re-entrancy guard so the adapter ignores the
//     synthetic click/keydown it fires during resume (else it loops
//     and the real send never lands),
//   • `readComposerText` through the shared `stripHtmlToText` walk so
//     multi-paragraph `<p>`/`<br>` don't glue,
//   • `resume()` — send button resolved FRESH, `sendButton.click()`
//     SYNCHRONOUSLY (inside the proceed-click activation window; no
//     `await` before/after), KeyboardEvent(Enter) fallback when the
//     button is absent/disabled,
//   • `postCheck` — submitted / failed / unknown from a synchronous,
//     race-safe read of the composer.
//
// Only a handful of things are site-specific and live in
// `SiteSubmitConfig`: the id, the composer + send-button selectors,
// the stable composer key, and an optional `matchesComposer` hook for
// custom-element wrappers (Gemini's `<rich-textarea>`). Per M0, an
// UNTRUSTED `sendButton.click()` submits on ChatGPT, Claude, AND
// Gemini (none check `isTrusted`), so the resume mechanism is shared.

import type { ResumeResult, SubmitAdapter, SubmitCore, SendIntent } from '../submit-core'
import { stripHtmlToText } from '../../clipboard-text'
import { isDocumentModalOpen } from '../../document-modal'
import { isPreviewModalOpen } from '../../preview-modal'

/** Per-site parameters. Everything else is shared in `BaseSubmitAdapter`. */
export interface SiteSubmitConfig {
  /** Adapter id — also the event-log site label and kill-switch key. */
  readonly id: string
  /** CSS selector for the composer. Resolved fresh every event. */
  readonly composerSelector: string
  /**
   * CSS selector for the send button. MUST match ONLY the send button,
   * never the Stop control the site swaps to while streaming. Resolved
   * fresh at resume time (the button appears/enables only once the
   * composer has text).
   */
  readonly sendButtonSelector: string
  /** Stable per-composer key for the core's re-entrancy scoping. */
  readonly composerKey: string
  /**
   * Optional composed-path membership test. Returns true if `el` is
   * (or hosts) this site's composer. Defaults to
   * `el.matches(composerSelector)`. Gemini overrides it because the
   * `<rich-textarea>` custom-element boundary can hide the inner
   * contenteditable from a naive `.matches`.
   */
  readonly matchesComposer?: (el: Element) => boolean
}

export interface SubmitAdapterOptions {
  /**
   * Master on/off (the extension's `enabled` toggle). Checked
   * synchronously per event so a disabled extension never blocks a
   * send. Defaults to always-on for standalone construction/tests.
   */
  readonly isMasterEnabled?: () => boolean
  /**
   * Compile-time/runtime submit-protection flag. Checked synchronously
   * per event; when false the adapter is a strict no-op (native send
   * proceeds untouched). Defaults to always-on so unit tests exercise
   * the intent path without the flag module.
   */
  readonly isFlagEnabled?: () => boolean
}

export class BaseSubmitAdapter implements SubmitAdapter {
  readonly id: string

  private readonly config: SiteSubmitConfig
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
   * True only while THIS adapter is performing a resume (a synchronous
   * `sendButton.click()` or a re-dispatched Enter). Our own
   * capture-phase listeners would otherwise re-intercept the synthetic
   * click/keydown we just fired — an infinite hold loop where the real
   * send never reaches the site. The flag makes the listeners ignore
   * our own events. Synchronous set/reset: the synthetic event
   * dispatches (and our listener runs) inline within `click()` /
   * `dispatchEvent()`, all inside the try/finally.
   */
  private resuming = false

  constructor(config: SiteSubmitConfig, opts: SubmitAdapterOptions = {}) {
    this.config = config
    this.id = config.id
    this.isMasterEnabled = opts.isMasterEnabled ?? (() => true)
    this.isFlagEnabled = opts.isFlagEnabled ?? (() => true)
  }

  attach(core: SubmitCore): void {
    this.core = core
    // Capture phase on window: the outermost target in the DOM event
    // flow, so we run before the site's own keymap / send-button
    // handler. `run_at: document_start` + capture also wins
    // registration-order ties on the same node.
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

  /**
   * V1.3 M5 self-test seam: resolve the site composer element the
   * adapter would act on (a fresh query — prefers the focused editor).
   * Used only by the one-click "Test protection" runner to insert
   * synthetic text into a fresh tab's empty composer. Returns null when
   * no composer is present (page still loading / unsupported view).
   */
  resolveComposer(): HTMLElement | null {
    return this.queryComposer()
  }

  // ── SubmitAdapter surface the core calls ──

  readComposerText(): string {
    const el = this.currentComposer()
    if (el === null) return ''
    // Textarea/input path (defensive — every current site is
    // contenteditable, but a future site might not be).
    const value = (el as HTMLTextAreaElement).value
    if (typeof value === 'string' && el.tagName === 'TEXTAREA') return value
    // Contenteditable → reuse the EMR paste-fix walk so `<p>`/`<br>`
    // boundaries become separators (no glued paragraphs) and
    // script/style never leak into the detector input.
    return stripHtmlToText(el.innerHTML)
  }

  resume(): ResumeResult {
    const el = this.currentComposer()
    const before = el === null ? '' : this.readComposerText()
    const button = this.resolveSendButton(el)

    // Primary: click the site's own send button, resolved fresh. MUST
    // be synchronous — inside the proceed-click activation window. No
    // await before or after. `this.resuming` makes our own
    // capture-phase click listener ignore this synthetic click.
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
    // confirmed the app acts on an untrusted KeyboardEvent too. Same
    // re-entrancy guard so our own keydown listener ignores it.
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

    // Nothing to act on — no usable button and no composer. The only
    // genuine, synchronously-certain failure (feeds the core's
    // kill-switch counter).
    return 'failed'
  }

  // ── send-intent listeners ──

  private readonly onKeydown = (event: KeyboardEvent): void => {
    if (event.key !== 'Enter') return
    if (!this.shouldIntercept()) return
    // Never intercept a newline or an IME-composition Enter. The IME
    // guard is doubled (`isComposing` AND legacy `keyCode === 229`)
    // because some builds/engines only set one; missing either breaks
    // CJK candidate confirmation.
    if (event.shiftKey) return
    if (event.isComposing || event.keyCode === 229) return
    const composer = this.resolveComposerFrom(event)
    if (composer === null) return
    // Only intercept when the event actually targets the composer — a
    // global Enter elsewhere on the page is not a send.
    if (!eventTargetsComposer(event, composer)) return
    this.intercept(event, composer)
  }

  private readonly onClick = (event: MouseEvent): void => {
    if (!this.shouldIntercept()) return
    const button = this.sendButtonInPath(event)
    if (button === null) return
    // A disabled send button click is a no-op for the site too — don't
    // intercept it (nothing to send yet).
    if (!isButtonUsable(button)) return
    // Anchor the composer to the CLICKED button, not to the first
    // document match. A click moves focus onto the button, so
    // `resolveComposerFrom`'s activeElement/query fallback can drift
    // onto an unrelated composer when the page has more than one (e.g.
    // Claude's edit-a-previous-message box beside the main composer).
    // The button and its composer share a send container, so walking up
    // from the button finds the RIGHT draft to scan and resume.
    const composer = this.resolveComposerForButton(button) ?? this.resolveComposerFrom(event)
    if (composer === null) return
    this.intercept(event, composer)
  }

  /**
   * Synchronous gate for whether this adapter may take the send. All
   * conditions must hold BEFORE we `preventDefault`, so a disabled flag
   * / toggle / kill-switch always leaves the site's native send
   * working.
   */
  private shouldIntercept(): boolean {
    // Never intercept the synthetic click/keydown we ourselves fire
    // during resume() — that would loop and the real send would never
    // land.
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
    // `composer` is the element the composed-path walk matched — which,
    // for a custom-element wrapper (Gemini's `<rich-textarea>`), can be
    // the HOST rather than the inner editor. `eventTargetsComposer`
    // above already validated against that matched element; from here
    // on we operate on the NORMALIZED inner editable so
    // `readComposerText` reads only the editor (not host chrome /
    // placeholders) and the resume Enter fallback dispatches on the
    // element the site's key binding actually listens on.
    const editable = normalizeComposer(composer)
    this.pendingComposer = editable
    this.pendingOpener = editable
    const intent: SendIntent = { composerKey: this.config.composerKey }
    const core = this.core
    if (core === null) return
    void core
      .handleSendIntent(this, intent)
      .catch(() => {
        // The core never rejects, but guard anyway — a throw here must
        // not leave the page wedged.
      })
      .finally(() => {
        this.pendingComposer = null
        this.pendingOpener = null
      })
  }

  // ── helpers (config-driven; per-instance) ──

  /** Prefer the event-time element; fall back to a fresh query if it detached. */
  private currentComposer(): HTMLElement | null {
    if (this.pendingComposer !== null && this.pendingComposer.isConnected) {
      return this.pendingComposer
    }
    return this.queryComposer()
  }

  private queryComposer(): HTMLElement | null {
    // Prefer the composer the user is actually IN over the first match
    // in the document. A site may render more than one element matching
    // the composer selector (an artifact editor, an edit-in-place box
    // for a previous message); the FOCUSED one is the live draft, so
    // scanning it — and resuming into it — cannot drift onto an
    // unrelated editor. Falls back to the first document match only
    // when nothing composer-shaped has focus.
    const active = document.activeElement
    if (active instanceof HTMLElement) {
      if (this.composerMatches(active)) return active
      const owning = active.closest<HTMLElement>(this.config.composerSelector)
      if (owning !== null) return owning
    }
    return document.querySelector<HTMLElement>(this.config.composerSelector)
  }

  private composerMatches(el: Element): boolean {
    if (this.config.matchesComposer) return this.config.matchesComposer(el)
    return el.matches(this.config.composerSelector)
  }

  /** Resolve the composer from the event's composed path, else a fresh query. */
  private resolveComposerFrom(event: Event): HTMLElement | null {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : []
    for (const node of path) {
      if (node instanceof Element && this.composerMatches(node)) {
        return node as HTMLElement
      }
    }
    return this.queryComposer()
  }

  /**
   * Resolve the composer that OWNS a clicked send button. Walk up from
   * the button; the nearest ancestor whose subtree contains a composer
   * yields that button's composer. On every current site the composer
   * and its send button share a send container, so this lands on the
   * clicked draft even when the page renders several composers (Claude's
   * edit box, an artifact editor) — where "first document match" could
   * drift onto an unrelated draft.
   */
  private resolveComposerForButton(button: Element): HTMLElement | null {
    let node: Element | null = button.parentElement
    while (node !== null) {
      const composer = node.querySelector<HTMLElement>(this.config.composerSelector)
      if (composer !== null) return composer
      node = node.parentElement
    }
    return null
  }

  /**
   * Send button for THIS send. Prefer the button co-located with the
   * pending composer (walk up to the shared send container) so a
   * multi-composer page resumes the SAME draft it scanned — clicking the
   * first document button could submit an unrelated composer. Falls back
   * to the first document match when no composer is known (the button is
   * resolved fresh here, so it reflects the live enabled/disabled state).
   */
  private resolveSendButton(composer: HTMLElement | null): HTMLButtonElement | null {
    let node: Element | null = composer
    while (node !== null) {
      const button = node.querySelector<HTMLButtonElement>(this.config.sendButtonSelector)
      if (button !== null) return button
      node = node.parentElement
    }
    return document.querySelector<HTMLButtonElement>(this.config.sendButtonSelector)
  }

  private sendButtonInPath(event: Event): HTMLButtonElement | null {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : []
    for (const node of path) {
      if (node instanceof Element && node.matches(this.config.sendButtonSelector)) {
        return node as HTMLButtonElement
      }
    }
    return null
  }

  /**
   * Synchronous post-check after a resume attempt.
   *   • couldn't attempt at all            → 'failed'
   *   • composer detached after the action → 'submitted'
   *   • composer text cleared / changed    → 'submitted'
   *   • attempted but text unchanged       → 'unknown' (ProseMirror/
   *     React/Angular may clear on a later tick; NEVER report 'failed'
   *     on a completed action, or a successful send would spuriously
   *     trip the kill switch)
   *
   * The signal is the COMPOSER, not the send button: a button that is
   * absent/disabled is only meaningful if it changed as a result of
   * our action, which we can't attribute synchronously — the fallback
   * path has no button at all. Composer text change / detachment is
   * the attributable evidence.
   */
  private postCheck(el: HTMLElement | null, before: string, attempted: boolean): ResumeResult {
    if (!attempted) return 'failed'
    if (el === null || !el.isConnected) return 'submitted'
    const after = this.readComposerText()
    if (before.trim().length > 0 && after !== before) return 'submitted'
    // Acted on a live composer but the text is still there — may be an
    // async clear. Race-safe: not confirmed, not failed.
    return 'unknown'
  }
}

// ─── truly site-agnostic free helpers (no config, no per-instance state) ──

function isButtonUsable(button: HTMLButtonElement): boolean {
  if (button.disabled) return false
  if (button.getAttribute('aria-disabled') === 'true') return false
  return true
}

/**
 * Re-dispatch an Enter keydown on the composer as the fallback resume.
 * Chrome honours `keyCode`/`which` from the init dict; we also define
 * them defensively for engines that don't. Returns the `dispatchEvent`
 * result (false if a handler cancelled it — which for a send binding
 * still means it was acted upon).
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
  // `dispatchEvent` returns false when a listener called preventDefault
  // — for an Enter-to-send binding that is the normal "the site
  // handled it" signal, so a canceled event counts as an attempt.
  el.dispatchEvent(event)
  return true
}

/**
 * Map a matched composer element down to the inner editable. For
 * ChatGPT/Claude the match already IS the contenteditable, so this is a
 * no-op; for Gemini a `<rich-textarea>` host match resolves to the
 * `[contenteditable]` inside it, so `readComposerText` reads only the
 * editor and the resume Enter fallback dispatches on the element the
 * site's key binding listens on.
 */
function normalizeComposer(el: HTMLElement): HTMLElement {
  if (el.matches('[contenteditable="true"]') || el.tagName === 'TEXTAREA') return el
  const inner = el.querySelector<HTMLElement>('[contenteditable="true"], textarea')
  return inner ?? el
}

function eventTargetsComposer(event: Event, composer: HTMLElement): boolean {
  const path = typeof event.composedPath === 'function' ? event.composedPath() : []
  if (path.includes(composer)) return true
  const target = event.target
  return target instanceof Node && (target === composer || composer.contains(target))
}

/**
 * True while any AI Leak Guard warning modal is on screen. Both modal
 * singletons expose an `isOpen` predicate; either being up means the
 * keys belong to the modal.
 */
function isAnyGuardModalOpen(): boolean {
  return isDocumentModalOpen() || isPreviewModalOpen()
}
