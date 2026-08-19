// V1.2 A1.1 isolated-world handler for FSA `hold-request` messages.
//
// The MAIN-world `showOpenFilePicker` wrapper posts a `hold-request`
// with file metadata and awaits a `hold-decision` reply. This module
// installs the listener that turns those requests into decisions:
//
//   flag OFF / not in scope / extension disabled
//                      → reply `upload-anyway` immediately
//                        (byte-for-byte pass-through — the MAIN-world
//                        wrapper returns the original handles and
//                        the site cannot tell we were in the loop)
//
//   another modal already open   → reply `cancel` (drop-on-the-floor
//                                   policy matches V1.1 paste and A1
//                                   change / drop / paste)
//
//   otherwise                    → open the placeholder document
//                                   modal with the file count and
//                                   forward the outcome
//
// Kept separate from `index.ts` so the listener wiring and the flag /
// modal / reply plumbing are unit-testable with fabricated events.

import {
  isFsaHoldRequest,
  FSA_MESSAGE_SOURCE,
  type FsaDecision,
  type FsaHoldDecision,
  type FsaHoldRequest,
} from './main-world/fsa-messages'

/**
 * Injectable seams so the handler can be exercised without a real
 * feature flag or a real Shadow-DOM modal.
 */
export interface FsaHandlerDeps {
  /** Is the document-protection flow eligible on this site right now? */
  readonly isActive: () => boolean
  /** Is any V1.1 preview or A1 document modal already on screen? */
  readonly isAnotherModalOpen: () => boolean
  /** Opens the document-protection modal and resolves with the user's choice. */
  readonly showModal: (opts: { fileCount: number }) => Promise<'upload-anyway' | 'cancel'>
}

function replyDecision(target: Window, request: FsaHoldRequest, decision: FsaDecision): void {
  const reply: FsaHoldDecision = {
    source: FSA_MESSAGE_SOURCE,
    kind: 'hold-decision',
    id: request.id,
    decision,
  }
  // Same-origin postMessage — matches the MAIN-world wrapper's
  // `location.origin` restriction. Same-window messaging never
  // crosses origins, but we keep the origin explicit so a future
  // reader sees the intent.
  target.postMessage(reply, target.location.origin)
}

/**
 * Handle a single `hold-request`. Exported for tests; the production
 * wiring in `installFsaMessageHandler` calls this from a `message`
 * listener.
 */
export async function handleFsaHoldRequest(
  target: Window,
  request: FsaHoldRequest,
  deps: FsaHandlerDeps,
): Promise<void> {
  if (!deps.isActive()) {
    replyDecision(target, request, 'upload-anyway')
    return
  }
  if (deps.isAnotherModalOpen()) {
    replyDecision(target, request, 'cancel')
    return
  }
  const outcome = await deps.showModal({ fileCount: request.files.length })
  replyDecision(target, request, outcome)
}

/**
 * Install the window `message` listener that turns `hold-request`
 * messages into decisions. Returns an uninstall function for tests.
 */
export function installFsaMessageHandler(target: Window, deps: FsaHandlerDeps): () => void {
  const listener = (event: MessageEvent): void => {
    // Same-window only — an iframe posting into us is not this
    // window's picker.
    if (event.source !== target) return
    if (!isFsaHoldRequest(event.data)) return
    void handleFsaHoldRequest(target, event.data, deps).catch((err) => {
      // Never let a handler error leave a MAIN-world wrapper hanging.
      // If the modal throws or the deps blow up, reply cancel — the
      // wrapper will throw AbortError, and the site treats that as a
      // normal user cancel.
      console.error('[AI Leak Guard] FSA hold handler error:', err)
      replyDecision(target, event.data, 'cancel')
    })
  }
  target.addEventListener('message', listener)
  return () => target.removeEventListener('message', listener)
}
