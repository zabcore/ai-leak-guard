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
// wraps the picker and talks to the isolated world through
// `window.postMessage`, using the shared contract in
// `fsa-messages.ts`. All hold / modal / flag decisions live in the
// isolated world, which stays the single source of truth for the
// V1.2 document-protection surface.
//
// Metadata-only. Never posts `File` objects, `Blob`s, or bytes across
// the world boundary — only `{ name, size, type }` per file. That
// preserves the "hold references only, don't read contents" invariant
// A1 established (see `docs/ARCHITECTURE.md`).

import {
  FSA_MESSAGE_SOURCE,
  isFsaHoldDecision,
  type FsaDecision,
  type FsaFileMetadata,
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
  askDecision: (files: readonly FsaFileMetadata[]) => Promise<FsaDecision>,
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

    // Extract File objects to read metadata. `.getFile()` on a
    // FileSystemFileHandle is metadata-cheap in Chrome; we do NOT
    // call `.text()` / `.arrayBuffer()` / anything that would read
    // bytes. The `File` object itself stays inside the MAIN world.
    const files = await Promise.all(handles.map((h) => h.getFile()))
    const metadata: FsaFileMetadata[] = files.map((f) => ({
      name: f.name,
      size: f.size,
      type: f.type,
    }))

    const decision = await askDecision(metadata)

    if (decision === 'upload-anyway') {
      // Silent release — return exactly what the native picker
      // returned; the site cannot tell we were in the loop.
      return handles
    }
    // Cancel path: throw the same DOMException the native picker
    // throws on user cancel so consumer sites handle it exactly as
    // they already do for cancellations.
    throw new DOMException('The user aborted a request.', 'AbortError')
  }

  ;(wrapped as unknown as WrappedMarker).__algWrapped = true
  return wrapped
}

/**
 * postMessage-based `askDecision` implementation used by the
 * production install below. Sends a `hold-request` and resolves with
 * the matching `hold-decision`.
 *
 * The listener validates every incoming message with
 * `isFsaHoldDecision` (rejecting foreign / malformed messages) and
 * requires the id to match this specific request, so concurrent
 * pickers on the same page cannot cross wires.
 */
export function askIsolatedWorld(
  target: Window,
  origin: string,
  files: readonly FsaFileMetadata[],
): Promise<FsaDecision> {
  return new Promise((resolve) => {
    const id = generateRequestId()
    const listener = (event: MessageEvent): void => {
      // Same-window messaging only — a message from an iframe or
      // another window is unrelated to our hold.
      if (event.source !== target) return
      if (!isFsaHoldDecision(event.data)) return
      if (event.data.id !== id) return
      target.removeEventListener('message', listener)
      resolve(event.data.decision)
    }
    target.addEventListener('message', listener)
    const request: FsaHoldRequest = {
      source: FSA_MESSAGE_SOURCE,
      kind: 'hold-request',
      id,
      files,
    }
    // targetOrigin `origin` (== `location.origin`) — restrict delivery
    // to the same origin so we cannot leak metadata to a cross-origin
    // frame that has been embedded (belt & suspenders — same-window
    // postMessage already goes only to same-window listeners, but
    // this keeps the surface explicit).
    target.postMessage(request, origin)
  })
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
  const wrapped = createWrappedPicker(orig, (files) =>
    askIsolatedWorld(target, target.location.origin, files),
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
