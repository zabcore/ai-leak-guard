// V1.2 A1.1 MAIN-world hook for `window.showOpenFilePicker`.
//
// Why MAIN world? The File System Access picker is invoked by
// **the page's own JavaScript** on the page's `window`. Our isolated
// content script cannot see the page's globals, so overriding
// `showOpenFilePicker` from there would be invisible to ChatGPT's
// bundle. This file ships as a separate `content_scripts` entry with
// `"world": "MAIN"` and `"run_at": "document_start"` so the wrapper
// is installed on the page's own window before ChatGPT can capture
// a reference to the original function.
//
// The MAIN-world script deliberately contains NO app logic — it only
// wraps the picker and talks to the isolated world through an
// EXTENSION-PRIVATE `MessagePort`. A public `window.postMessage`
// carries only the one-shot `alg-fsa-hello` at load; the port
// (handed to us via `alg-fsa-port-handoff` with a transfer list) is
// the sole channel for hold-request / hold-decision traffic. Page
// scripts cannot obtain a reference to a `MessagePort` transferred
// via someone else's postMessage, so they can neither read requests
// nor forge decisions once the handshake completes.
//
// A3.1 note. The hold-request now also carries the picker's `File[]`
// alongside the metadata, structured-cloned onto the private port so
// the isolated inspector can run extraction + detection locally
// (closing the coverage gap that made the FSA picker path the only
// site path never scanned). This is NOT "user data leaked to the
// page":
//   • The transfer runs on the private `MessagePort`, not
//     `window.postMessage`; page listeners never observe it.
//   • `upload-anyway` returns the ORIGINAL `FileSystemFileHandle[]`
//     the picker produced — MAIN keeps that reference and hands it
//     back to the site. The isolated-world clone is a separate
//     value the wrapper never surfaces, so the site sees the same
//     handles a native picker call would have produced, byte-for-
//     byte. (Whether the browser's structured-clone shares the
//     underlying byte sequence is implementation-defined; we don't
//     depend on it — the site's byte-identical result comes from
//     returning MAIN's originals, not from clone-sharing.)
//   • The reply stays decision-only (`upload-anyway` / `cancel`); no
//     matched-value bytes ever come back over the port.
//   • MAIN drops its `File[]` reference the moment the decision
//     resolves, so the "hold references only, drop when done"
//     invariant A1 established still applies (see
//     `docs/ARCHITECTURE.md`).

import {
  FSA_HELLO_SOURCE,
  FSA_MESSAGE_SOURCE,
  isFsaHoldDecision,
  isFsaPortHandoff,
  type FsaDecision,
  type FsaFileMetadata,
  type FsaHello,
  type FsaHoldRequest,
} from './fsa-messages'

/**
 * Minimal handle shape we depend on — `FileSystemFileHandle` from the
 * File System Access API. Redeclared locally so this MAIN-world
 * script has zero DOM-lib coupling beyond `Window` / `File`, and so
 * the wrapper compiles even when a build target does not include the
 * FSA lib types.
 */
export interface FileHandleLike {
  getFile(): Promise<File>
}

export type ShowOpenFilePickerFn = (...args: unknown[]) => Promise<FileHandleLike[]>

interface WrappedMarker {
  __algWrapped?: boolean
}

/**
 * Build the replacement `showOpenFilePicker` that runs the original
 * picker, extracts file metadata, defers to `askDecision`, and either
 * returns the original handles (upload-anyway) or throws the same
 * `AbortError` a native cancel throws.
 *
 * Kept factory-style so the wrapper is exercisable from Vitest
 * without touching `window`.
 */
export function createWrappedPicker(
  orig: ShowOpenFilePickerFn,
  askDecision: (
    metadata: readonly FsaFileMetadata[],
    blobs: readonly File[],
  ) => Promise<FsaDecision>,
): ShowOpenFilePickerFn {
  const wrapped: ShowOpenFilePickerFn = async (...args: unknown[]) => {
    // Run the native picker first — this pops the OS file dialog and
    // waits for the user to select or cancel. If the user cancels the
    // NATIVE dialog, `orig` throws `AbortError` and this wrapper
    // propagates it as-is; no message crosses the world boundary.
    const handles = await orig.apply(globalThis as unknown as Window, args)

    // Defensive: if the site called the picker but the caller (or a
    // future browser) returned an empty list, pass it straight
    // through. No files means nothing to hold.
    if (!Array.isArray(handles) || handles.length === 0) return handles

    // Extract File objects for both metadata AND the isolated
    // inspector. `.getFile()` on a FileSystemFileHandle is
    // metadata-cheap in Chrome; the returned `File` is a lazy
    // reference to the underlying bytes and only reads them when
    // something calls `.text()` / `.arrayBuffer()` / a stream. The
    // originals stay in MAIN so `upload-anyway` returns the same
    // handles the native picker produced; a structured clone crosses
    // the private port for local extraction + detection.
    let files: File[] | null = await Promise.all(handles.map((h) => h.getFile()))
    const metadata: FsaFileMetadata[] = files.map((f) => ({
      name: f.name,
      size: f.size,
      type: f.type,
    }))

    try {
      const decision = await askDecision(metadata, files)

      if (decision === 'upload-anyway') {
        // Silent release — return exactly what the native picker
        // returned; the site cannot tell we were in the loop.
        return handles
      }
      // Cancel path: throw the same DOMException the native picker
      // throws on user cancel so consumer sites handle it exactly as
      // they already do for cancellations.
      throw new DOMException('The user aborted a request.', 'AbortError')
    } finally {
      // Drop MAIN's local `File` array the moment the decision
      // resolves (or throws). The site still holds the ORIGINAL
      // handles; upload-anyway returned them above. Anything the
      // isolated inspector cloned onto the port is that side's
      // problem to release.
      files = null
    }
  }

  ;(wrapped as unknown as WrappedMarker).__algWrapped = true
  return wrapped
}

// Handshake timeout. Content scripts at `document_start` (both
// isolated and MAIN world) run before any page script, so a healthy
// install completes in the same microtask. 2000 ms is generous for
// slow devices while still short enough that a broken install fails
// fast and the site sees a bounded latency instead of a hang.
export const FSA_HANDSHAKE_TIMEOUT_MS = 2000

/**
 * Request a `MessagePort` from the isolated world via the
 * hello / port-handoff handshake. The port then carries every
 * hold-request / hold-decision.
 *
 * Handshake:
 *
 *   MAIN   → { source: 'alg-fsa-hello' }        (window.postMessage)
 *   MAIN   ← { source: 'alg-fsa-port-handoff' } (window.postMessage + [port] transfer)
 *
 * Realm caveat: the MAIN-world script shares a JavaScript realm with
 * the page, and `window.postMessage(..., [port2])` exposes the
 * transferred port through `MessageEvent.ports` to any listener on
 * that window — including page listeners registered before ours. A
 * hostile page can therefore attempt a first-hello-hijack to claim
 * the one-shot port before us, in which case this promise REJECTS
 * on the handshake timeout. `askIsolatedWorld` then catches the
 * rejection and fails open to `'upload-anyway'`, matching the
 * "document protection warns, never blocks" invariant (see
 * `docs/ARCHITECTURE.md` — "FSA picker interception").
 *
 * Exported for tests. Rejects with `Error('alg-fsa handshake timed out')`
 * if no valid port-handoff arrives within `FSA_HANDSHAKE_TIMEOUT_MS`.
 */
export function requestPort(target: Window, origin: string): Promise<MessagePort> {
  return new Promise((resolve, reject) => {
    let settled = false
    const cleanup = (): void => {
      target.removeEventListener('message', listener)
      clearTimeout(timer)
    }
    const listener = (event: MessageEvent): void => {
      if (event.source !== target) return
      if (!isFsaPortHandoff(event.data)) return
      const port = event.ports[0]
      if (!port) return
      if (settled) return
      settled = true
      cleanup()
      // `.start()` is required when the port will be read via
      // `addEventListener('message')` rather than the auto-starting
      // `onmessage` setter.
      port.start()
      resolve(port)
    }
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      cleanup()
      reject(new Error('alg-fsa handshake timed out'))
    }, FSA_HANDSHAKE_TIMEOUT_MS)
    target.addEventListener('message', listener)
    const hello: FsaHello = { source: FSA_HELLO_SOURCE }
    target.postMessage(hello, origin)
  })
}

// Decision timeout. Long enough that any realistic user interaction
// with the modal completes (a power user reading a multi-file summary
// still finishes well under a minute); short enough to unstick the
// site if the isolated world gets torn down mid-flow (extension
// unload, mid-picker update). On timeout we fail open — matches the
// "warn, don't block" invariant.
export const FSA_DECISION_TIMEOUT_MS = 120_000

/**
 * Send one hold-request over the private `port` and resolve with the
 * matching `hold-decision`. Because `port` is a transferred
 * `MessagePort`, only the isolated world can post replies on it —
 * a page script cannot forge a decision.
 *
 * The listener still validates every incoming message with
 * `isFsaHoldDecision` and requires the id to match this specific
 * request, so concurrent pickers cannot cross wires.
 *
 * If no matching decision arrives within `FSA_DECISION_TIMEOUT_MS`,
 * fails open to `'upload-anyway'` (safety net for isolated-world
 * outages — see the constant's rationale).
 *
 * Exported for tests so an adversarial regression test can assert
 * that a `hold-decision` posted via `window.postMessage` is IGNORED
 * even after a valid request has been observed.
 */
export function askOverPort(
  port: MessagePort,
  metadata: readonly FsaFileMetadata[],
  blobs: readonly File[],
): Promise<FsaDecision> {
  return new Promise((resolve) => {
    const id = generateRequestId()
    let settled = false
    const cleanup = (): void => {
      port.removeEventListener('message', listener)
      clearTimeout(timer)
    }
    const listener = (event: MessageEvent): void => {
      if (!isFsaHoldDecision(event.data)) return
      if (event.data.id !== id) return
      if (settled) return
      settled = true
      cleanup()
      resolve(event.data.decision)
    }
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      cleanup()
      resolve('upload-anyway')
    }, FSA_DECISION_TIMEOUT_MS)
    port.addEventListener('message', listener)
    const request: FsaHoldRequest = {
      source: FSA_MESSAGE_SOURCE,
      kind: 'hold-request',
      id,
      files: metadata,
      blobs,
    }
    // `File` is structured-cloneable, so postMessage on the private
    // `MessagePort` hands the isolated world a fresh `File`. No
    // transfer list and no ownership hand-off — MAIN keeps its
    // originals and returns them to the site on upload-anyway. Any
    // marshalling cost is up to the browser (Chrome typically shares
    // the immutable byte sequence rather than copying).
    port.postMessage(request)
  })
}

/**
 * Production `askDecision` implementation: obtain the private port
 * (lazily, once per document) and ask it for a decision.
 *
 * Fail-open on handshake failure. If the handshake never completes
 * (isolated content script not injected, first-hello-hijack by a
 * page script, extension disabled mid-load), `requestPort` rejects
 * with a timeout and we return `'upload-anyway'` — the wrapper then
 * returns the original handles and the site sees a byte-for-byte
 * native picker call. This matches the "document protection warns,
 * never blocks" invariant: a broken extension MUST NOT hang the
 * user's picker or throw a spurious `AbortError`.
 *
 * A failed handshake is NOT cached — a subsequent picker call gets
 * a fresh attempt in case the isolated world came up late.
 */
export function askIsolatedWorld(
  target: Window,
  origin: string,
  metadata: readonly FsaFileMetadata[],
  blobs: readonly File[],
): Promise<FsaDecision> {
  return getOrRequestPort(target, origin).then(
    (port) => askOverPort(port, metadata, blobs),
    () => 'upload-anyway' as FsaDecision,
  )
}

let cachedPortPromise: Promise<MessagePort> | null = null

function getOrRequestPort(target: Window, origin: string): Promise<MessagePort> {
  if (cachedPortPromise !== null) return cachedPortPromise
  const pending = requestPort(target, origin)
  cachedPortPromise = pending
  // Do NOT cache a failed handshake. If this attempt times out, the
  // next picker call gets a fresh handshake — the isolated world may
  // have come up in the meantime, or a first-hello-hijack race may
  // have unblocked.
  pending.catch(() => {
    if (cachedPortPromise === pending) cachedPortPromise = null
  })
  return pending
}

/** Test seam: forget the cached port so a fresh handshake happens. */
export function __resetPortForTesting(): void {
  cachedPortPromise = null
}

function generateRequestId(): string {
  // crypto.randomUUID is available in every browser this extension
  // supports; fall back defensively if unavailable so tests /
  // environments without it still work.
  const c = (globalThis as unknown as { crypto?: { randomUUID?: () => string } }).crypto
  if (c && typeof c.randomUUID === 'function') return `alg-fsa-${c.randomUUID()}`
  return `alg-fsa-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`
}

/**
 * Install the wrapper on the given window's `showOpenFilePicker`.
 * Idempotent — a second call (e.g. from a defensive re-inject or
 * from a hot reload during development) sees `__algWrapped` and
 * returns without re-wrapping.
 *
 * Returns `'installed'` / `'already-wrapped'` / `'unavailable'` so
 * tests can observe the install path.
 */
export function installFsaHook(target: Window): 'installed' | 'already-wrapped' | 'unavailable' {
  const holder = target as unknown as { showOpenFilePicker?: ShowOpenFilePickerFn & WrappedMarker }
  const current = holder.showOpenFilePicker
  if (typeof current !== 'function') return 'unavailable'
  if (current.__algWrapped === true) return 'already-wrapped'
  const orig = current.bind(target) as ShowOpenFilePickerFn
  const wrapped = createWrappedPicker(orig, (metadata, blobs) =>
    askIsolatedWorld(target, target.location.origin, metadata, blobs),
  )
  holder.showOpenFilePicker = wrapped
  return 'installed'
}

// Auto-install on load. `content_scripts` MAIN-world entries at
// `document_start` run before the page's own scripts, so this wraps
// the original before ChatGPT / any other consumer captures a
// reference to it. The IIFE is a no-op in the Vitest environment
// (where `window.showOpenFilePicker` is undefined) so importing the
// module for unit tests does not pollute test-runtime globals.
;(() => {
  if (typeof window === 'undefined') return
  try {
    installFsaHook(window)
  } catch {
    // Never break the page; installing the hook is best-effort.
  }
})()
