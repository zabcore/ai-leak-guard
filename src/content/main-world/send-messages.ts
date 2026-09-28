// V1.3.5 — message contract for the MAIN-world Enter-reclaim shim.
//
// Some surfaces (Gemini) install their OWN earliest capture-phase Enter
// handler in the PAGE's world that calls `stopImmediatePropagation()`, so the
// isolated-world submit adapter's `window` capture listener never sees Enter →
// send-time protection silently fails open (measured live 2026-09-28). The fix
// is a MAIN-world shim (`send-capture.ts`) injected at `document_start` — it
// registers the FIRST window-capture Enter listener (before the page bundle),
// blocks the native send in the page's own world, and bridges the intent to the
// isolated-world adapter (`send-bridge.ts`).
//
// The two worlds coordinate over `window.postMessage`, same-origin only. Three
// tiny, content-free messages — no user text, no filenames, no findings ever
// cross:
//   • isolated → MAIN : `ready`       — the bridge is installed; the shim may
//                                       ARM (before ready it stays dormant, so
//                                       a disabled/absent extension never blocks
//                                       a send — fail-open at startup).
//   • MAIN → isolated : `hello`       — shim announces itself so a bridge that
//                                       came up first re-sends `ready`.
//   • MAIN → isolated : `send-intent` — a composer Enter was blocked; run the
//                                       real scan → modal → resume flow.
//
// Threat model: only the site's OWN page scripts share the MAIN-world realm,
// and that first party already owns its composer and send button — so a forged
// `send-intent` grants it no capability it lacks (it can already send). The
// isolated bridge still re-runs the full synchronous gate (flag/toggle/kill-
// switch/modal) and re-resolves the composer before acting.

export const SEND_MESSAGE_SOURCE = 'alg-send'

export type SendBridgeKind = 'hello' | 'ready' | 'send-intent'

export interface SendBridgeMessage {
  readonly source: typeof SEND_MESSAGE_SOURCE
  readonly kind: SendBridgeKind
}

function isSendBridgeMessage(data: unknown, kind: SendBridgeKind): data is SendBridgeMessage {
  if (typeof data !== 'object' || data === null) return false
  const m = data as { source?: unknown; kind?: unknown }
  return m.source === SEND_MESSAGE_SOURCE && m.kind === kind
}

export const isSendHello = (data: unknown): data is SendBridgeMessage =>
  isSendBridgeMessage(data, 'hello')
export const isSendReady = (data: unknown): data is SendBridgeMessage =>
  isSendBridgeMessage(data, 'ready')
export const isSendIntent = (data: unknown): data is SendBridgeMessage =>
  isSendBridgeMessage(data, 'send-intent')

export const helloMessage: SendBridgeMessage = { source: SEND_MESSAGE_SOURCE, kind: 'hello' }
export const readyMessage: SendBridgeMessage = { source: SEND_MESSAGE_SOURCE, kind: 'ready' }
export const sendIntentMessage: SendBridgeMessage = {
  source: SEND_MESSAGE_SOURCE,
  kind: 'send-intent',
}
