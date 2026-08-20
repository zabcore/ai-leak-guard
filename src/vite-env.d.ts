// Ambient type declarations for Vite-specific import syntaxes we
// rely on at runtime. Keeps `tsc --noEmit` clean without pulling in
// the full `vite/client` types (which brings in `import.meta.env`
// semantics we don't want to imply everywhere).

// pdf.js worker imported with the `?worker` suffix — Vite bundles
// the worker as a separate chunk and returns a `Worker` constructor
// from the default export. Kept for legacy paths that still use the
// factory form; A4.1 (#39) switched pdf.ts + xlsx.ts to `?url` so
// the URL can be re-anchored via `chrome.runtime.getURL()` — see
// `formats/worker-url.ts`.
declare module '*?worker' {
  const workerCtor: new () => Worker
  export default workerCtor
}

// `?url` returns the bundled asset's URL as a string. In a content-
// script bundle that's a page-relative absolute path like
// `/assets/xxx-<hash>.js` which we route through
// `chrome.runtime.getURL()` before spawning a Worker.
declare module '*?url' {
  const url: string
  export default url
}
