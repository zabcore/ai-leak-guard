// Cross-world message contract for the V1.2 A1.1 FSA hook (extended
// in A3.1 to carry `File` objects to the isolated world for local
// scanning).
//
// This module is deliberately import-free — the MAIN-world script
// (isolated JS context, no access to the extension's isolated-world
// bundle) and the isolated-world content script both build against
// the same shapes and validators without pulling in Chrome APIs,
// Node types, or any DOM helpers.
//
// A1.1 crossed only metadata (`{name,size,type}` per file). The
// change/drop/paste paths ran the file inspector (extraction +
// detection) directly on the isolated side, but the FSA picker path
// couldn't — so `showOpenFilePicker` uploads never got scanned. A3.1
// closes that gap:
//
//   • Hold-request now also carries a **structured-cloneable `File[]`**
//     alongside the `FsaFileMetadata[]`. The isolated inspector reads
//     these to extract text + run detection locally. Whether the
//     browser shares the underlying byte sequence between MAIN's
//     originals and the isolated-side clones is implementation-
//     defined (Chrome typically does, since `Blob` / `File` are
//     immutable — see W3C FileAPI + WHATWG structured-clone) — we
//     don't rely on it.
//   • The transfer runs on the EXTENSION-PRIVATE `MessagePort`, not
//     `window.postMessage`. Page scripts can't observe or forge it
//     (see the port-handoff notes below), so this is not "user data
//     leaked to the page" — it's the extension's isolated side
//     receiving the files it needs to run detection locally.
//   • `upload-anyway` returns the **original picker handles** MAIN
//     still holds — the wrapper never returns anything derived from
//     the clone, so the site sees the same handles it would have got
//     from a native picker call, byte-for-byte.
//   • The reply is still decision-only (`upload-anyway`/`cancel`).
//     No matched-value bytes ever cross back to MAIN. The A1
//     "hold references only, don't read contents until the
//     inspector needs to" invariant still applies — the isolated
//     world reads bytes for extraction + detection, then drops its
//     references when the decision resolves.

export const FSA_MESSAGE_SOURCE = 'alg-fsa'

export type FsaDecision = 'upload-anyway' | 'cancel'

export interface FsaFileMetadata {
  readonly name: string
  readonly size: number
  readonly type: string
}

export interface FsaHoldRequest {
  readonly source: typeof FSA_MESSAGE_SOURCE
  readonly kind: 'hold-request'
  readonly id: string
  /**
   * Kept for backwards compatibility and cheap logging on the
   * isolated side. Always parallel to `blobs` (same length + order),
   * so the isolated handler can render "N files, first: foo.pdf"
   * without touching the File objects.
   */
  readonly files: readonly FsaFileMetadata[]
  /**
   * The actual `File` objects the picker returned, cloned into the
   * isolated world via the structured-clone algorithm when the
   * hold-request is posted on the private `MessagePort`. The
   * isolated inspector reads bytes from these to extract text and
   * run detection; the reply back to MAIN stays decision-only.
   *
   * `upload-anyway` returns the ORIGINAL picker handles MAIN still
   * holds — independent of these clones. The wrapper never surfaces
   * anything derived from the clone to the site.
   */
  readonly blobs: readonly File[]
}

export interface FsaHoldDecision {
  readonly source: typeof FSA_MESSAGE_SOURCE
  readonly kind: 'hold-decision'
  readonly id: string
  readonly decision: FsaDecision
}

export type FsaMessage = FsaHoldRequest | FsaHoldDecision

// ─── Handshake (window.postMessage only) ────────────────────────────────
// The MAIN-world wrapper asks the isolated world for a `MessagePort`
// at load. This is the ONLY exchange that flows over the shared
// `window.postMessage` bus; every subsequent hold-request /
// hold-decision travels on the returned port.
//
// Guarantee (post-handshake): the port cannot be reached via window
// messaging — hold-request and hold-decision traffic is not
// observable to page listeners, and page scripts cannot forge a
// decision on the port. This closes the trivial "observe id on
// window, post forged decision on window" bypass.
//
// Realm caveat (see `docs/ARCHITECTURE.md` — "FSA picker
// interception"): our MAIN-world script shares a JS realm with the
// page, and the `alg-fsa-port-handoff` message that transfers `port2`
// runs through `window.postMessage`, which exposes the port to any
// `message` listener via `MessageEvent.ports`. A page script racing
// us at document_start can therefore attempt a first-hello-hijack
// (post its own hello, receive `port2` first). We can't
// cryptographically prevent this in a shared realm; the hook's
// bounded handshake timeout + fail-open path in
// `src/content/main-world/fsa-hook.ts` keeps document protection at
// "warn, never block" even when the hijack succeeds.
//
// The handshake is deliberately tiny: hello (no payload) /
// port-handoff (port is on the transfer list).

export const FSA_HELLO_SOURCE = 'alg-fsa-hello'
export const FSA_PORT_HANDOFF_SOURCE = 'alg-fsa-port-handoff'

export interface FsaHello {
  readonly source: typeof FSA_HELLO_SOURCE
}

export interface FsaPortHandoff {
  readonly source: typeof FSA_PORT_HANDOFF_SOURCE
}

export function isFsaHello(x: unknown): x is FsaHello {
  return isPlainObject(x) && x.source === FSA_HELLO_SOURCE
}

export function isFsaPortHandoff(x: unknown): x is FsaPortHandoff {
  return isPlainObject(x) && x.source === FSA_PORT_HANDOFF_SOURCE
}

// ─── Validation ─────────────────────────────────────────────────────────
// The isolated world MUST reject anything that fails these predicates
// so foreign scripts on the page cannot forge a decision (which would
// let a page release its own picker without user confirmation) or a
// bogus hold-request (which would open a modal out of nowhere).

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

function isString(x: unknown): x is string {
  return typeof x === 'string'
}

function isNonNegativeInteger(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x) && x >= 0
}

function isFsaFileMetadata(x: unknown): x is FsaFileMetadata {
  if (!isPlainObject(x)) return false
  return isString(x.name) && isNonNegativeInteger(x.size) && isString(x.type)
}

/**
 * True when `x` structurally looks like a `Blob` / `File` — a `size`
 * number and an `arrayBuffer()` method. Duck-typed rather than
 * `instanceof File` because structured-clone across a `MessagePort`
 * can round-trip a `File` into a distinct realm's constructor (in
 * real Chrome the constructor tends to match; in Node/jsdom test
 * environments it does not, so an `instanceof` check would falsely
 * reject legitimate cloned files). Rejecting a plain metadata object
 * — the realistic forgery — still works because a plain object has
 * no `arrayBuffer` method.
 */
function isBlobLike(x: unknown): boolean {
  if (typeof x !== 'object' || x === null) return false
  const b = x as { size?: unknown; arrayBuffer?: unknown }
  return typeof b.size === 'number' && typeof b.arrayBuffer === 'function'
}

/**
 * True when `x` is a well-formed `hold-request` message. The isolated
 * world uses this to gate opening a modal.
 */
export function isFsaHoldRequest(x: unknown): x is FsaHoldRequest {
  if (!isPlainObject(x)) return false
  if (x.source !== FSA_MESSAGE_SOURCE) return false
  if (x.kind !== 'hold-request') return false
  if (!isString(x.id) || x.id.length === 0) return false
  if (!Array.isArray(x.files)) return false
  if (!x.files.every(isFsaFileMetadata)) return false
  if (!Array.isArray(x.blobs)) return false
  if (x.blobs.length !== x.files.length) return false
  return x.blobs.every(isBlobLike)
}

/**
 * True when `x` is a well-formed `hold-decision` message. The MAIN
 * world uses this to gate resolving the wrapped picker's promise.
 */
export function isFsaHoldDecision(x: unknown): x is FsaHoldDecision {
  if (!isPlainObject(x)) return false
  if (x.source !== FSA_MESSAGE_SOURCE) return false
  if (x.kind !== 'hold-decision') return false
  if (!isString(x.id) || x.id.length === 0) return false
  return x.decision === 'upload-anyway' || x.decision === 'cancel'
}
