// V1.2 M4 (#39) — extension-origin worker URL resolver.
//
// Vite's `?url` import returns the bundled chunk's URL string. In a
// content-script context the returned string is a page-relative
// absolute path like `/assets/pdf.worker-<hash>.js`, so spawning
// `new Worker(url, …)` with it opens
// `https://<page-host>/assets/pdf.worker-<hash>.js`, which 404s and
// leaves the caller waiting for a Worker that will never load.
// `document-flow`'s 10 s extraction timer eventually fires and the
// file is reported `unable_to_inspect / timeout` — which reads as a
// generic hang to the user, and blocks the flow long enough that
// nobody would guess the real cause is a resource mismatch.
//
// Fix: route the `?url` string through `chrome.runtime.getURL()` so
// it resolves against the extension's own origin
// (`chrome-extension://<extension-id>/assets/…`). The Worker is then
// backed by the file the build actually emitted, and the WAR entry
// keeps it reachable from the matched page contexts.
//
// The `assertExtensionOriginWorkerUrl` guard is the single invariant
// A4.1 relies on — a follow-up bundler bump or a test-env mock that
// silently returned a bare `/assets/…` path would otherwise let the
// hang regression sneak back in.

const EXTENSION_ORIGIN_PREFIX = 'chrome-extension://'

/**
 * Turn a `?url`-import string (page-relative absolute path in a
 * content script) into an extension-origin URL and enforce the
 * invariant that the result actually points at the extension.
 *
 * @param rawUrl the string exported by a `pdf.worker.mjs?url` /
 *               `./xlsx.worker.ts?url` import. In production this is
 *               `/assets/…`; in the CRXJS dev server it may be an
 *               absolute URL already (`chrome-extension://…`), which
 *               `chrome.runtime.getURL` accepts unchanged.
 * @returns the resolved worker URL, always starting with
 *          `chrome-extension://`.
 * @throws if `chrome.runtime.getURL` is unavailable or the resolved
 *         URL does not live under the extension origin.
 */
export function resolveExtensionWorkerUrl(rawUrl: string): string {
  // In a CRXJS dev-mode HMR reload the emitted url is sometimes an
  // already-fully-qualified `chrome-extension://…` string. `getURL`
  // strips a leading slash but doesn't handle a bare URL, so short-
  // circuit before we hand it in.
  if (rawUrl.startsWith(EXTENSION_ORIGIN_PREFIX)) {
    return assertExtensionOriginWorkerUrl(rawUrl)
  }
  const getURL =
    typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.getURL === 'function'
      ? chrome.runtime.getURL.bind(chrome.runtime)
      : null
  if (getURL === null) {
    throw new Error(
      `[AI Leak Guard] worker URL: chrome.runtime.getURL is unavailable — cannot resolve ${rawUrl}`,
    )
  }
  // `chrome.runtime.getURL` treats leading `/` as an absolute path
  // rooted at the extension origin, which is exactly the layout Vite
  // produces (`/assets/…`). Strip the leading slash defensively so
  // we behave the same way if a future bundler drops it.
  const relative = rawUrl.startsWith('/') ? rawUrl.slice(1) : rawUrl
  const resolved = getURL(relative)
  return assertExtensionOriginWorkerUrl(resolved)
}

/**
 * Enforce the invariant that a worker URL is extension-hosted. Kept
 * exported so tests can pin the invariant directly, and so an
 * accidental future call site that gets its URL from somewhere other
 * than `resolveExtensionWorkerUrl` can gate on the same predicate.
 */
export function assertExtensionOriginWorkerUrl(url: string): string {
  if (!url.startsWith(EXTENSION_ORIGIN_PREFIX)) {
    throw new Error(
      `[AI Leak Guard] worker URL: expected an extension-origin URL, got ${JSON.stringify(url)}`,
    )
  }
  return url
}
