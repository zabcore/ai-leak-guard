// V1.2 M4 (#39) — extension-origin worker URL resolver + blob spawn.
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
// Fix v1: route the `?url` string through `chrome.runtime.getURL()`
// so it resolves against the extension's own origin
// (`chrome-extension://<extension-id>/assets/…`). The Worker is then
// backed by the file the build actually emitted, and the WAR entry
// keeps it reachable from the matched page contexts. That covered
// the page-origin 404 but left one gap:
//
// Fix v2 (this file, current shape): strict-CSP sites — claude.ai is
// the confirmed case — reject `new Worker(chrome-extension://…)`
// when the Worker is spawned from a content-script context. The
// page's CSP `worker-src` clause doesn't allow the extension scheme,
// so the Worker never loads and extraction throws `parse-error`.
// `blob:` workers on the other hand ARE allowed on the current four
// target sites (verified in-page). So we now:
//
//   1. Resolve the extension URL exactly as before
//      (`resolveExtensionWorkerUrl`), enforcing the same-origin
//      invariant against the active extension. `chrome.runtime.getURL`
//      remains the single source of truth for the extension URL.
//   2. `fetch(url)` from the content-script context to pull the
//      worker code. Content scripts are permitted to fetch their own
//      web-accessible resources from any page origin without extra
//      permissions and without triggering the page's connect-src CSP
//      (extension-privileged fetch).
//   3. Wrap the response body in a `Blob({type: 'text/javascript'})`
//      and hand `new Worker(URL.createObjectURL(blob), …)` the
//      resulting `blob:` URL, which the page CSP accepts.
//   4. Revoke the object URL right after the constructor returns —
//      the browser has already initiated the worker script fetch by
//      then, so the revocation doesn't tear the Worker down.
//
// The `assertExtensionOriginWorkerUrl` guard still fires on the
// FETCH source. The `spawnExtensionWorkerFromBlob` helper is the
// single seam callers use — a direct `new Worker(chrome-extension://…)`
// would silently regress the fix on strict-CSP sites, so the helper
// is where the invariant lives.

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
  const getURL =
    typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.getURL === 'function'
      ? chrome.runtime.getURL.bind(chrome.runtime)
      : null
  if (getURL === null) {
    throw new Error(
      `[AI Leak Guard] worker URL: chrome.runtime.getURL is unavailable — cannot resolve ${rawUrl}`,
    )
  }
  // Active extension origin, e.g. `chrome-extension://<our-ext-id>/`.
  // `getURL('')` returns the origin plus a trailing slash — the
  // canonical way to obtain the current extension's URL prefix.
  const ownOrigin = getURL('')
  if (rawUrl.startsWith(EXTENSION_ORIGIN_PREFIX)) {
    // Already-qualified URL — accept ONLY when it belongs to OUR
    // extension origin. Rejecting bare-prefix matches prevents a
    // scenario where a colluding extension (or a mocked import in
    // a shared browser process) hands us a `chrome-extension://<other-id>/…`
    // URL and lures us into spawning a Worker against their code.
    if (!urlHasOrigin(rawUrl, ownOrigin)) {
      throw new Error(
        `[AI Leak Guard] worker URL: ${JSON.stringify(rawUrl)} does not belong to this extension (${ownOrigin})`,
      )
    }
    return assertExtensionOriginWorkerUrl(rawUrl)
  }
  // `chrome.runtime.getURL` treats leading `/` as an absolute path
  // rooted at the extension origin, which is exactly the layout Vite
  // produces (`/assets/…`). Strip the leading slash defensively so
  // we behave the same way if a future bundler drops it.
  const relative = rawUrl.startsWith('/') ? rawUrl.slice(1) : rawUrl
  const resolved = getURL(relative)
  // Same-origin enforcement, applied symmetrically to both the
  // qualified-URL path above and this resolved path — a stubbed or
  // buggy `chrome.runtime.getURL` implementation that hands back
  // `chrome-extension://<other-id>/…` (or any non-extension URL)
  // must NOT lead to a Worker being spawned there. The
  // `assertExtensionOriginWorkerUrl` guard catches non-extension
  // origins; this one specifically catches OTHER extensions.
  if (!urlHasOrigin(resolved, ownOrigin)) {
    throw new Error(
      `[AI Leak Guard] worker URL: resolved ${JSON.stringify(resolved)} does not belong to this extension (${ownOrigin})`,
    )
  }
  return assertExtensionOriginWorkerUrl(resolved)
}

/**
 * True when `url` shares the `chrome-extension://<id>/` prefix of
 * `origin` (both must be extension-origin URLs; `origin` is the
 * `chrome.runtime.getURL('')` result — protocol + host + trailing
 * slash). Simple prefix compare rather than `URL.origin` parsing so
 * this stays dependency-free and callable from the worker configure
 * paths without instantiating a `URL`.
 */
function urlHasOrigin(url: string, origin: string): boolean {
  // Guard against a caller passing an origin without the trailing
  // slash — matching `chrome-extension://foo` against
  // `chrome-extension://foobar/…` would otherwise be a false positive.
  const normalisedOrigin = origin.endsWith('/') ? origin : `${origin}/`
  return url.startsWith(normalisedOrigin)
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

/**
 * Detect Vite's raw-source shim shape — a chunk whose entire body is
 * `var e = "data:video/mp2t;base64,<raw-TS>"` followed by an
 * export. The pattern is deliberately loose (Vite may rename `e` on
 * a future release) but pinned on the tell-tale `data:video/mp2t`
 * MIME string that only appears when a `.ts` module was exported
 * via `?url`. A production-compiled worker never contains this
 * pattern — the compiled bytecode is inline, not embedded as a
 * data-URL string.
 */
function looksLikeRawSourceShim(code: string): boolean {
  // The whole shim is small (~2-4 KB) and always contains the
  // data:video/mp2t marker within the first few hundred bytes.
  return code.length < 8_000 && code.includes('data:video/mp2t')
}

/** Structural shape for the (subset of the) Worker constructor we need. */
export interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void
  terminate(): void
  addEventListener?(type: string, listener: (e: Event) => void): void
  onmessage?: ((event: MessageEvent) => void) | null
  onerror?: ((event: unknown) => void) | null
}

interface SpawnOptions {
  readonly type?: 'module' | 'classic'
  /** Test seam — inject a fake Worker constructor to sidestep jsdom. */
  readonly workerCtor?: new (url: string, opts?: WorkerOptions) => WorkerLike
  /** Test seam — override the fetch used to pull the worker code. */
  readonly fetchImpl?: typeof fetch
}

/**
 * Fetch the extension-origin worker resource named by `rawUrl` (a
 * `?url`-import string) and spawn a Worker from a `blob:` URL wrapping
 * the response body.
 *
 * `blob:` workers are accepted by every current target site's CSP;
 * `chrome-extension:` workers are rejected by strict-CSP sites
 * (claude.ai confirmed) even when the extension has the resource in
 * `web_accessible_resources`. Content scripts are allowed to
 * `fetch()` their own WAR resources with no additional permission and
 * without triggering the page's `connect-src` (extension-privileged
 * fetch), which is what makes this workaround valid.
 *
 * Invariants enforced here:
 *   • the fetch source URL sits on OUR extension origin
 *     (`resolveExtensionWorkerUrl`);
 *   • the response is OK (a broken WAR entry becomes a loud error
 *     instead of a silent hang inside the worker's own load);
 *   • the resulting `blob:` URL is revoked promptly so we don't leak
 *     it into the page's URL cache. The browser fetches the worker
 *     script synchronously during `new Worker(...)`, so revoking on
 *     the next microtask cannot race the worker's script load.
 */
export async function spawnExtensionWorkerFromBlob(
  rawUrl: string,
  opts: SpawnOptions = {},
): Promise<WorkerLike> {
  const extensionUrl = resolveExtensionWorkerUrl(rawUrl)
  const doFetch = opts.fetchImpl ?? fetch
  const response = await doFetch(extensionUrl)
  if (!response.ok) {
    throw new Error(
      `[AI Leak Guard] worker fetch: ${response.status} ${response.statusText} for ${extensionUrl}`,
    )
  }
  const code = await response.text()
  // Guard against the `?url`-on-TypeScript footgun. Vite treats
  // `?url` on a `.ts` module as "give me the raw source as a static
  // asset" and emits a chunk that just points at a
  // `data:video/mp2t;base64,<raw-TS>` blob. Spawning that as a
  // Worker runs uncompiled TypeScript, which throws on the first
  // `import`. A4.2 shipped exactly this bug for xlsx; A4.3 fixed
  // the import to `?worker&url` and this guard makes the regression
  // loud instead of silent — a broken import now throws at spawn
  // time with a clear message, not four seconds later as a generic
  // `parse-error`.
  if (looksLikeRawSourceShim(code)) {
    throw new Error(
      `[AI Leak Guard] worker: fetched a raw-source shim (Vite \`?url\` on a .ts file) for ${extensionUrl} — use \`?worker&url\` and configure the worker output to be self-contained instead.`,
    )
  }
  const blob = new Blob([code], { type: 'text/javascript' })
  const blobUrl = URL.createObjectURL(blob)
  const WorkerCtor = opts.workerCtor ?? (globalThis as { Worker: typeof Worker }).Worker
  try {
    const worker = new WorkerCtor(
      blobUrl,
      opts.type ? { type: opts.type } : undefined,
    ) as WorkerLike
    // Revoke on the next microtask — the Worker constructor has
    // already read the URL and initiated the script load, so this
    // does NOT tear the worker down. We do this in-band rather than
    // via setTimeout so the revoke happens before any user code
    // runs a subsequent `URL.createObjectURL` that might see the
    // stale blob in the URL cache.
    void Promise.resolve().then(() => URL.revokeObjectURL(blobUrl))
    return worker
  } catch (err) {
    // Constructor threw — the URL is never handed to the browser's
    // worker loader, so revoke immediately to avoid leaking it.
    URL.revokeObjectURL(blobUrl)
    throw err
  }
}
