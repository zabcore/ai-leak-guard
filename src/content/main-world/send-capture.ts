// V1.3.5 — MAIN-world Enter-reclaim shim (Gemini send-time interception fix).
//
// Root cause (proven live 2026-09-28, gemini.google.com/app, ext 1.3.4):
// Gemini installs its OWN earliest capture-phase Enter handler in the PAGE's
// world that calls `stopImmediatePropagation()`. Because
// `stopImmediatePropagation` halts every remaining listener on the target —
// across BOTH the page world and the extension's isolated world — the isolated
// submit adapter's `window` capture `keydown` listener never runs for Enter.
// Send-time protection failed open: an un-intercepted Enter still submitted.
//
// Why MAIN world: content scripts run in the ISOLATED world; the isolated
// listener cannot beat a page-world capture listener that stops immediate
// propagation. This shim ships as a `content_scripts` entry with
// `"world": "MAIN"` + `"run_at": "document_start"`, so it registers the FIRST
// window-capture `keydown` listener on the page's own window BEFORE Gemini's
// bundle executes — winning the ordered capture race. It blocks the native send
// (`preventDefault` + `stopImmediatePropagation`) and bridges the intent to the
// isolated world, which runs the real scan → warning-modal → resume flow.
//
// Fail-open by ARMING: the shim stays dormant until the isolated bridge posts
// `ready`. A disabled/absent extension never posts `ready`, so the shim never
// blocks a send. (Resume itself is unchanged — the isolated adapter clicks the
// site's send button, which submits from an untrusted click per M0.)
//
// IME / Shift+Enter preserved: a composing Enter (`isComposing` OR legacy
// `keyCode === 229`) and Shift+Enter are never treated as a send, exactly like
// the isolated keydown path.

import {
  helloMessage,
  sendIntentMessage,
  selfTestProbeResult,
  isSendReady,
  isSendHello,
  isSelfTestProbe,
} from './send-messages'

/**
 * Composer handles for Gemini's Quill editor, locale-independent. The live
 * editor is `rich-textarea .ql-editor[contenteditable="true"]` (Quill); the
 * older bare `rich-textarea [contenteditable="true"]` and the `<rich-textarea>`
 * host are kept so a composed-path node at any boundary still matches.
 */
export const GEMINI_COMPOSER_SELECTOR =
  'rich-textarea .ql-editor[contenteditable="true"], rich-textarea [contenteditable="true"], rich-textarea'

/** True when `event` is a plain composer-targeted send Enter (not a newline,
 *  not an IME composition/confirm). Pure — exported for tests. */
export function isComposerSendEnter(event: KeyboardEvent, selector: string): boolean {
  if (event.key !== 'Enter') return false
  if (event.shiftKey) return false
  // IME guard DOUBLED (isComposing AND legacy keyCode 229) — missing either
  // breaks CJK candidate confirmation, matching the isolated keydown path.
  if (event.isComposing || event.keyCode === 229) return false
  const path = typeof event.composedPath === 'function' ? event.composedPath() : []
  for (const node of path) {
    if (node instanceof Element && node.matches(selector)) return true
  }
  const target = event.target
  if (target instanceof Element) {
    if (target.matches(selector) || target.closest(selector) !== null) return true
  }
  return false
}

export interface SendCaptureController {
  install(): void
  destroy(): void
  /** True once the isolated bridge has acknowledged (the shim will act). */
  isArmed(): boolean
}

export interface SendCaptureDeps {
  readonly win: Window
  readonly origin: string
  readonly selector?: string
}

/**
 * Build the shim controller. `install()` registers the earliest window-capture
 * keydown listener plus the arming handshake listener, and announces itself
 * with `hello`. Factory form so Vitest can drive it without touching the real
 * page window.
 */
export function createSendCapture(deps: SendCaptureDeps): SendCaptureController {
  const { win, origin } = deps
  const selector = deps.selector ?? GEMINI_COMPOSER_SELECTOR
  let armed = false
  // While a self-test probe Enter is in flight, block it (to measure that WE
  // are the first-capture handler) but do NOT bridge a send-intent — the probe
  // runs on an EMPTY composer purely to prove ordering, never to send.
  let probing = false

  const onMessage = (event: MessageEvent): void => {
    // Same-window, same-origin only.
    if (event.source !== win) return
    if (isSendReady(event.data)) {
      armed = true
      return
    }
    if (isSelfTestProbe(event.data)) {
      // A probe can only come from the isolated bridge, which exists only when
      // protection is installed — so arm now too, removing any ready/probe
      // ordering race that could otherwise misreport a real interceptor.
      armed = true
      runSelfTestProbe()
    }
  }

  const onKeydown = (event: KeyboardEvent): void => {
    // Dormant until the isolated bridge is confirmed alive (fail-open).
    if (!armed) return
    if (!isComposerSendEnter(event, selector)) return
    // Reclaim the send: block the native submit AND the page's own Enter
    // handler (this listener is registered first, so stopImmediatePropagation
    // halts Gemini's handler too), then bridge to the isolated world.
    event.preventDefault()
    event.stopImmediatePropagation()
    event.stopPropagation()
    // Probe mode: prove first-capture only; never bridge (no scan, no send).
    if (probing) return
    try {
      win.postMessage(sendIntentMessage, origin)
    } catch {
      // Best-effort; never throw into the page's event dispatch.
    }
  }

  // Self-test probe: dispatch a synthetic Enter on the (empty) composer in the
  // PAGE's own world so our own capture listener can see it, and report whether
  // WE blocked it first. Empty composer → a fall-through cannot send.
  const runSelfTestProbe = (): void => {
    let blocked = false
    try {
      const doc = win.document
      const target =
        doc.querySelector<HTMLElement>('rich-textarea .ql-editor[contenteditable="true"]') ??
        doc.querySelector<HTMLElement>(selector)
      if (target !== null) {
        probing = true
        const probe = new KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
          cancelable: true,
          composed: true,
        })
        target.dispatchEvent(probe)
        blocked = probe.defaultPrevented
      }
    } catch {
      blocked = false
    } finally {
      probing = false
    }
    try {
      win.postMessage(selfTestProbeResult(blocked), origin)
    } catch {
      // best-effort
    }
  }

  const install = (): void => {
    win.addEventListener('message', onMessage)
    // Capture phase on window — the earliest slot; registered at document_start
    // before the page bundle, so it wins the ordered capture race for Enter.
    win.addEventListener('keydown', onKeydown, true)
    // Announce ourselves so a bridge that installed first re-sends `ready`.
    try {
      win.postMessage(helloMessage, origin)
    } catch {
      // ignore
    }
  }

  const destroy = (): void => {
    win.removeEventListener('message', onMessage)
    win.removeEventListener('keydown', onKeydown, true)
  }

  return { install, destroy, isArmed: () => armed }
}

// Auto-install on load. A MAIN-world `content_scripts` entry at document_start
// runs before the page's own scripts, so this registers the first window
// capture keydown listener. `isSendHello` is referenced so a page-first bridge
// handshake stays symmetric; the isolated side answers hello with ready.
void isSendHello

let autoController: SendCaptureController | null = null
;(() => {
  if (typeof window === 'undefined') return
  // Skip the load-time install under Vitest: jsdom has a real `window`, so an
  // auto-installed window listener would leak across test files. Unit tests
  // construct their own controller explicitly.
  if (typeof process !== 'undefined' && process.env !== undefined && process.env.VITEST) return
  try {
    autoController = createSendCapture({ win: window, origin: window.location.origin })
    autoController.install()
  } catch {
    // Never break the page; the shim is best-effort.
  }
})()

/** Test seam: tear down the auto-installed shim so a unit test controls its own
 *  (jsdom has a `window`, so the module's load-time install would otherwise leak
 *  a window listener across cases). No-op in production. */
export function __resetSendCaptureForTests(): void {
  autoController?.destroy()
  autoController = null
}
