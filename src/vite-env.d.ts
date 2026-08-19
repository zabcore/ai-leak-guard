// Ambient type declarations for Vite-specific import syntaxes we
// rely on at runtime. Keeps `tsc --noEmit` clean without pulling in
// the full `vite/client` types (which brings in `import.meta.env`
// semantics we don't want to imply everywhere).

// pdf.js worker imported with the `?worker` suffix — Vite bundles
// the worker as a separate chunk and returns a `Worker` constructor
// from the default export. See `src/content/extraction/formats/pdf.ts`.
declare module '*?worker' {
  const workerCtor: new () => Worker
  export default workerCtor
}
