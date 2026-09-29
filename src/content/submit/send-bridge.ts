// V1.3.5 — isolated-world side of the MAIN-world Enter-reclaim bridge.
//
// Pairs with `main-world/send-capture.ts`. On install it announces `ready`
// (arming the shim) and, from then on, answers a shim `hello` with `ready` and
// runs `onSendIntent` for every `send-intent`. `onSendIntent` drives the SAME
// scan → warning-modal → resume flow the isolated keydown path uses — see
// `BaseSubmitAdapter.handleExternalSendIntent`.
//
// Only the site's own page scripts share the MAIN-world realm and they already
// own the composer + send button, so a forged `send-intent` grants no new
// capability; the adapter re-runs its full synchronous gate and re-resolves the
// composer before acting either way.

import {
  SEND_MESSAGE_SOURCE,
  readyMessage,
  selfTestProbeMessage,
  isSendHello,
  isSendIntent,
  isSelfTestProbeResult,
} from '../main-world/send-messages'

export interface SendBridgeDeps {
  /** The window whose messages to observe / post to (default `window`). */
  readonly target?: Window
  /** The page origin to post to (default `location.origin`). */
  readonly origin?: string
  /** Run the real send-intent flow (block already happened in the page world). */
  readonly onSendIntent: () => void
}

/**
 * Install the isolated-world bridge. Returns a remover (test hygiene). Posts
 * `ready` immediately so a shim that is already waiting arms at once; also
 * re-sends `ready` on a later `hello` in case the shim came up after us.
 */
export function installSendBridge(deps: SendBridgeDeps): () => void {
  const target = deps.target ?? window
  const origin = deps.origin ?? location.origin

  const postReady = (): void => {
    try {
      target.postMessage(readyMessage, origin)
    } catch {
      // best-effort
    }
  }

  const onMessage = (event: MessageEvent): void => {
    // Same-window only (the shim shares this window). Ignore cross-window posts.
    if (event.source !== target) return
    if (isSendHello(event.data)) {
      postReady()
      return
    }
    if (isSendIntent(event.data)) {
      try {
        deps.onSendIntent()
      } catch {
        // Never let a bridge callback throw into the message pump.
      }
    }
  }

  target.addEventListener('message', onMessage)
  // Arm the shim now (it may already be installed and waiting).
  postReady()

  return () => target.removeEventListener('message', onMessage)
}

export interface ProbeShimDeps {
  readonly target?: Window
  readonly origin?: string
  /** How long to wait for the shim's probe reply before giving up. */
  readonly timeoutMs?: number
}

/**
 * V1.3.6 — ask the MAIN-world shim to prove it is installed AND wins the Enter
 * capture race, by dispatching a synthetic Enter on the EMPTY composer in the
 * page's own world and reporting whether it blocked it first. Resolves `true`
 * only on a `blocked: true` reply; resolves `false` on `blocked: false` or if no
 * reply arrives (shim absent / disabled) — so a disabled shim reads as NOT
 * confirmed, never a false green. Safe: the probe runs on an empty composer, so
 * a fall-through cannot send.
 */
export function probeShimInterception(deps: ProbeShimDeps = {}): Promise<boolean> {
  const target = deps.target ?? window
  const origin = deps.origin ?? location.origin
  const timeoutMs = deps.timeoutMs ?? 800
  return new Promise((resolve) => {
    let settled = false
    const cleanup = (): void => {
      target.removeEventListener('message', onMessage)
      clearTimeout(timer)
    }
    const onMessage = (event: MessageEvent): void => {
      if (event.source !== target) return
      if (!isSelfTestProbeResult(event.data)) return
      if (settled) return
      settled = true
      cleanup()
      resolve(event.data.blocked === true)
    }
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      cleanup()
      resolve(false)
    }, timeoutMs)
    target.addEventListener('message', onMessage)
    try {
      target.postMessage(selfTestProbeMessage, origin)
    } catch {
      // If posting fails there is no shim to answer — resolve false on timeout.
    }
  })
}

// Referenced so the shared source constant is part of this module's contract
// surface even when tree-shaking would otherwise drop it.
void SEND_MESSAGE_SOURCE
