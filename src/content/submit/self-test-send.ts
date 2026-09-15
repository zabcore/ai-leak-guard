// V1.3.3 — the self-test's send with an ABSOLUTE safety net.
//
// The load-bearing safety property of the whole self-test is: it must not be
// able to submit synthetic PHI to the provider, even if interception fails.
// "No resume seam" is not enough — the runner dispatches a REAL Enter, and if
// the submit adapter is disabled/absent that Enter would otherwise reach the
// site's own send handler and go out.
//
// So before dispatching, we install our OWN capture-phase keydown listener on
// `window` — the safety net. Two mutually-exclusive outcomes, and neither can
// send:
//   • the adapter is active → it runs FIRST (registered at document_start, so
//     it precedes this on-demand net among same-target capture listeners),
//     calls stopImmediatePropagation(), and the net never runs. The event is
//     prevented by the adapter and the site never sees it. → intercepted.
//   • the adapter is absent/bailed → it does NOT stop propagation, so the net
//     runs and unconditionally preventDefault + stopImmediatePropagation, so
//     the site's send handler never fires. → NOT intercepted, but NO send.
//
// The net is therefore the guarantee; the adapter is what we're measuring.
// `intercepted` is true only when the ADAPTER took the send (the net did not
// have to), which is the real signal the runner acts on.

export interface SelfTestSendResult {
  /** True iff the ADAPTER intercepted the send (the safety net did not fire). */
  readonly intercepted: boolean
  /** True iff the safety net had to block the send (adapter did not act). */
  readonly blockedBySafetyNet: boolean
}

/**
 * Dispatch the synthetic self-test Enter behind the safety net. Never lets the
 * synthetic text reach the provider. `target` defaults to `window` (where the
 * submit adapters listen); it is injectable only so tests can pin the target.
 */
export function dispatchSelfTestSend(
  el: HTMLElement,
  target: EventTarget = window,
): SelfTestSendResult {
  let netFired = false
  const safetyNet = (event: Event): void => {
    // Reached only when the adapter did NOT stopImmediatePropagation first —
    // i.e. interception is not active. Block the send unconditionally.
    netFired = true
    event.preventDefault()
    event.stopImmediatePropagation()
    event.stopPropagation()
  }

  // Capture phase, registered now (after the adapter's document_start listener)
  // so the adapter wins the ordered race and the net is the fallback.
  target.addEventListener('keydown', safetyNet, true)
  try {
    el.focus?.()
  } catch {
    // focus is best-effort
  }
  const event = new KeyboardEvent('keydown', {
    key: 'Enter',
    code: 'Enter',
    bubbles: true,
    cancelable: true,
    composed: true,
  })
  try {
    el.dispatchEvent(event)
  } finally {
    target.removeEventListener('keydown', safetyNet, true)
  }

  return {
    // Adapter interception = the event was prevented AND the net never had to.
    intercepted: event.defaultPrevented && !netFired,
    blockedBySafetyNet: netFired,
  }
}
