// V1.2 A1.1 isolated-world handler for FSA `hold-request` messages.
//
// The MAIN-world `showOpenFilePicker` wrapper needs an EXTENSION-PRIVATE
// channel to ask the isolated world for a decision — using
// `window.postMessage` for the decisions themselves would let any page
// script observe a `hold-request`, read its `id`, and post a forged
// `hold-decision` with `decision: 'upload-anyway'`, silently bypassing
// the modal.
//
// Solution (see `docs/ARCHITECTURE.md` — "FSA picker interception"):
// the isolated world owns a private `MessageChannel`. On the very
// first `alg-fsa-hello` from the MAIN wrapper we transfer `port2` to
// MAIN using the transfer list of a single `alg-fsa-port-handoff`
// message. From that point on, every hold-request travels MAIN → port1
// and every hold-decision travels port1 → MAIN. Page scripts cannot
// obtain a reference to a `MessagePort` transferred via someone else's
// `postMessage`, so they can neither read requests nor forge decisions
// once the handshake is done.
//
// Handshake window: the MAIN wrapper is installed at document_start
// and its hello fires immediately. Isolated-world content scripts also
// run at document_start (and typically before MAIN-world scripts on
// the same document), so `handleHello` is listening in time. If a
// stale hello arrives after the port has been transferred (only one
// consumer can hold a transferred port), it is silently dropped.
//
// Decision logic:
//
//   flag OFF / not in scope / extension disabled
//                      → reply `upload-anyway` immediately without
//                        touching the `File[]` on the request
//                        (byte-for-byte pass-through — the MAIN-world
//                        wrapper returns the original handles and
//                        the site cannot tell we were in the loop)
//
//   another modal already open   → reply `cancel` (drop-on-the-floor
//                                   policy matches V1.1 paste and A1
//                                   change / drop / paste)
//
//   otherwise                    → run `inspectFiles(request.blobs)`
//                                   locally (A3 extraction + V1.1
//                                   detection), then open the
//                                   placeholder document modal with
//                                   the file count + inspection and
//                                   forward the outcome. Refs to the
//                                   `File[]` are dropped as soon as
//                                   the decision resolves.

import {
  isFsaHello,
  isFsaHoldRequest,
  FSA_MESSAGE_SOURCE,
  FSA_PORT_HANDOFF_SOURCE,
  type FsaDecision,
  type FsaHoldDecision,
  type FsaHoldRequest,
  type FsaPortHandoff,
} from './main-world/fsa-messages'
import { inspectFiles, type FileInspection } from './file-inspector'

/**
 * Injectable seams so the handler can be exercised without a real
 * feature flag or a real Shadow-DOM modal.
 */
export interface FsaHandlerDeps {
  /** Is the document-protection flow eligible on this site right now? */
  readonly isActive: () => boolean
  /** Is any V1.1 preview or A1 document modal already on screen? */
  readonly isAnotherModalOpen: () => boolean
  /**
   * Opens the document-protection modal and resolves with the user's
   * choice. `inspection` carries the A3 per-file + aggregate scan
   * results the A4 modal will render its summary from. The
   * placeholder modal in V1.2 A3.1 only reads `fileCount`; A4 will
   * pick up `inspection` without touching this handler.
   */
  readonly showModal: (opts: {
    fileCount: number
    inspection: FileInspection
  }) => Promise<'upload-anyway' | 'cancel'>
  /**
   * Optional seam that overrides `inspectFiles` — kept ONLY for the
   * FSA handler unit tests, which stub inspection to skip pdf.js
   * lazy-load + jsdom quirks. Production leaves this undefined and
   * the handler calls the real `inspectFiles`.
   */
  readonly inspect?: (files: readonly File[]) => Promise<FileInspection>
}

/**
 * A minimal reply seam so `handleFsaHoldRequest` doesn't need to know
 * whether it's replying over a `MessagePort` (production) or into a
 * captured array (tests).
 */
export type FsaReply = (decision: FsaDecision) => void

function buildDecisionReply(port: MessagePort, request: FsaHoldRequest): FsaReply {
  return (decision) => {
    const reply: FsaHoldDecision = {
      source: FSA_MESSAGE_SOURCE,
      kind: 'hold-decision',
      id: request.id,
      decision,
    }
    port.postMessage(reply)
  }
}

/**
 * Turn one hold-request into a decision. Exported for tests; the
 * production wiring in `installFsaMessageHandler` calls this from the
 * port's `onmessage`.
 *
 * The `reply` seam is what makes this testable without a real port —
 * tests pass a `vi.fn()` and assert on its recorded calls.
 */
export async function handleFsaHoldRequest(
  request: FsaHoldRequest,
  deps: FsaHandlerDeps,
  reply: FsaReply,
): Promise<void> {
  if (!deps.isActive()) {
    // Never touch `request.blobs` when we're not going to prompt —
    // pass-through must stay bytes-untouched. The MAIN wrapper still
    // holds the ORIGINAL handles it will return to the site; our
    // structured-clone refs here fall out of scope with the request
    // as soon as this handler returns.
    reply('upload-anyway')
    return
  }
  if (deps.isAnotherModalOpen()) {
    reply('cancel')
    return
  }
  // Run A3 extraction + V1.1 detection over the picker's files
  // BEFORE opening the modal — the placeholder modal only reads
  // `fileCount` today, but A4 will render its summary from
  // `inspection` without any further changes to this handler.
  //
  // `inspectFiles` is documented never-throws; a per-file failure
  // becomes `unable_to_inspect` on that entry. So we don't need a
  // try/catch here — the outer handler's `catch` still guards the
  // rest of the flow.
  const inspect = deps.inspect ?? inspectFiles
  const inspection = await inspect(request.blobs)
  const outcome = await deps.showModal({
    fileCount: request.files.length,
    inspection,
  })
  reply(outcome)
  // Structured-clone refs to the picker's `File[]` are only held by
  // this handler's scope + the inspection result. Returning here
  // releases both — the modal's own callers must not persist
  // `inspection.perFile[*].meta.file` past this point.
}

/**
 * Install the private-channel handshake + hold-request handler on
 * `target`. Returns an uninstall function for tests.
 *
 * On install we create a fresh `MessageChannel`, keep `port1`, and
 * wait for the first `alg-fsa-hello` from the MAIN wrapper. When it
 * arrives we transfer `port2` (once) and thereafter route every
 * hold-request through the port.
 */
export function installFsaMessageHandler(target: Window, deps: FsaHandlerDeps): () => void {
  const channel = new MessageChannel()
  const port = channel.port1
  let port2: MessagePort | null = channel.port2

  port.onmessage = (event: MessageEvent): void => {
    // The port is extension-private: no page script can post here.
    // We still validate the shape defensively so a malformed message
    // from a future refactor cannot open a modal out of nowhere.
    if (!isFsaHoldRequest(event.data)) return
    const request = event.data
    const reply = buildDecisionReply(port, request)
    void handleFsaHoldRequest(request, deps, reply).catch((err) => {
      // Never let a handler error leave a MAIN-world wrapper hanging.
      // If the modal throws or the deps blow up, reply cancel — the
      // wrapper will throw AbortError, and the site treats that as a
      // normal user cancel.
      console.error('[AI Leak Guard] FSA hold handler error:', err)
      reply('cancel')
    })
  }

  const helloListener = (event: MessageEvent): void => {
    // Same-window only — an iframe posting into us is not this
    // window's picker asking to shake hands.
    if (event.source !== target) return
    if (!isFsaHello(event.data)) return
    // Only one consumer can ever hold `port2` (MessagePort transfer is
    // one-shot). Subsequent hellos are ignored: if the MAIN wrapper
    // dropped its port reference somehow we cannot re-issue anyway,
    // and dropping stale hellos is safer than trying to reopen.
    if (port2 === null) return
    const handoff: FsaPortHandoff = { source: FSA_PORT_HANDOFF_SOURCE }
    // `[port2]` transfer list moves the port into the MAIN-world
    // context; after this call our reference is neutered.
    target.postMessage(handoff, target.location.origin, [port2])
    port2 = null
  }
  target.addEventListener('message', helloListener)

  return () => {
    target.removeEventListener('message', helloListener)
    port.onmessage = null
    port.close()
  }
}
