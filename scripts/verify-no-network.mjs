// V1.3 M6 — build-time guard: ZERO programmatic outbound network
// (release blocker §10.8). AI Leak Guard is local-only: nothing it
// detects, masks, or logs may ever leave the device. This scans EVERY
// JS file in the built bundle (`dist/`) and fails the build if it finds
// a programmatic network API:
//
//   fetch(              XMLHttpRequest        navigator.sendBeacon
//   new WebSocket(      new EventSource(      import('http[s]://…')  (remote dynamic import)
//
// It deliberately does NOT flag `window.open(...)` or
// `chrome.tabs.create(...)`: those are USER-INITIATED tab opens (the
// self-test "Report this" opens the zabcore support page in a tab the
// user then submits) — they are not the extension issuing a request and
// carry no payload from the extension.
//
// Like verify-sw.mjs, string / template / regex literals and comments
// are stripped BEFORE scanning so a benign string constant that mentions
// one of these tokens (e.g. a doc comment, an allowlist name) doesn't
// trip the guard — only real code that CALLS the API does.
//
// VENDORED FORMAT PARSERS. The third-party document-extraction libraries
// (PDF.js, SheetJS/xlsx, the zip reader, docx/pptx parsers) ship their
// own network layers — e.g. PDF.js can fetch a PDF from a URL. AI Leak
// Guard NEVER exercises those paths: every extractor is handed IN-MEMORY
// data (an ArrayBuffer / Uint8Array from a local file), never a URL, and
// PDF.js specifically is driven with `disableAutoFetch: true`,
// `disableStream: true`, `isEvalSupported: false` (see
// src/content/extraction/formats/pdf.ts). So those chunks' network code
// is DEAD for our usage. They are allowlisted BY NAME below and printed
// on every run so the exemption stays visible/auditable; our OWN
// authored code (content script, service worker, popup — every other
// chunk) must be network-clean, and Vite emits vendored libraries in
// their own chunks, so nothing we wrote lands in an allowlisted file.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join, relative } from 'node:path'

const DIST = 'dist'

// Vendored extraction-library chunks (network APIs present but never
// invoked — driven with in-memory data, never a URL).
const VENDORED_ALLOWLIST = [
  {
    re: /^pdf(\.worker)?-[^/]*\.js$/,
    reason: 'vendored PDF.js — fed {data}; disableAutoFetch/disableStream',
  },
  { re: /^xlsx(\.worker)?-[^/]*\.js$/, reason: 'vendored SheetJS/xlsx — fed an ArrayBuffer' },
  { re: /^zip-[^/]*\.js$/, reason: 'vendored zip reader — fed an ArrayBuffer' },
  { re: /^docx-[^/]*\.js$/, reason: 'vendored docx parser — fed an ArrayBuffer' },
  { re: /^pptx-[^/]*\.js$/, reason: 'vendored pptx parser — fed an ArrayBuffer' },
]

function vendoredReason(file) {
  const name = basename(file)
  const hit = VENDORED_ALLOWLIST.find((v) => v.re.test(name))
  return hit ? hit.reason : null
}

// Each pattern is matched against the string/comment-STRIPPED code, so
// it only fires on real call sites, not on text inside a literal.
const FORBIDDEN = [
  { name: 'fetch()', re: /\bfetch\s*\(/ },
  { name: 'XMLHttpRequest', re: /\bXMLHttpRequest\b/ },
  { name: 'navigator.sendBeacon', re: /\bsendBeacon\b/ },
  { name: 'WebSocket', re: /\bWebSocket\b/ },
  { name: 'EventSource', re: /\bEventSource\b/ },
  // Dynamic import of a REMOTE url: `import("https://…")` /
  // `import('http://…')`. Local dynamic imports (`import('./x.js')`)
  // are fine and common in a bundle, so only the remote shape is
  // forbidden. Checked on the ORIGINAL code (the url lives in a string
  // literal the stripper would remove).
  { name: 'remote import()', re: /\bimport\s*\(\s*['"]https?:\/\//, raw: true },
]

/** Recursively collect every `.js` file under a directory. */
function collectJs(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) out.push(...collectJs(full))
    else if (entry.endsWith('.js')) out.push(full)
  }
  return out
}

/** Strip comments + string/template/regex literals (mirrors verify-sw.mjs). */
function strip(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1') // line comments (skip URLs after `:`)
    .replace(/`(?:\\.|[^`\\])*`/g, '``') // template literals
    .replace(/'(?:\\.|[^'\\])*'/g, "''") // single-quoted strings
    .replace(/"(?:\\.|[^"\\])*"/g, '""') // double-quoted strings
}

let files
try {
  files = collectJs(DIST)
} catch (err) {
  console.error(
    `[verify-no-network] Could not read ${DIST}/ — run \`npm run build\` first. (${err.message})`,
  )
  process.exit(1)
}

if (files.length === 0) {
  console.error(
    `[verify-no-network] No .js files found under ${DIST}/ — run \`npm run build\` first.`,
  )
  process.exit(1)
}

const violations = []
const allowlisted = []
for (const file of files) {
  const code = readFileSync(file, 'utf8')
  const scannable = strip(code)
  const hits = []
  for (const rule of FORBIDDEN) {
    const haystack = rule.raw ? code : scannable
    if (rule.re.test(haystack)) hits.push(rule.name)
  }
  if (hits.length === 0) continue
  const reason = vendoredReason(file)
  if (reason !== null) {
    // A vendored format parser (network code present but never invoked —
    // fed in-memory data, never a URL). Skip, but record for the audit
    // trail printed below.
    allowlisted.push({ file: relative('.', file), apis: hits, reason })
  } else {
    for (const api of hits) violations.push({ file: relative('.', file), api })
  }
}

// Always surface the allowlisted vendored chunks so the exemption is
// visible on every run, not silent.
for (const a of allowlisted) {
  console.log(
    `[verify-no-network] allowlisted vendored: ${a.file} (${a.apis.join(', ')}) — ${a.reason}`,
  )
}

if (violations.length > 0) {
  console.error('[verify-no-network] FORBIDDEN network API found in the built bundle:')
  for (const v of violations) console.error(`  • ${v.file} — ${v.api}`)
  console.error(
    '\nAI Leak Guard is local-only (release blocker §10.8). No programmatic outbound\n' +
      'network is permitted. If this is a user-initiated tab open, use window.open /\n' +
      'chrome.tabs.create (which this guard allows) rather than a network request.',
  )
  process.exit(1)
}

console.log(
  `[verify-no-network] OK — ${files.length} bundle file(s) checked; no fetch / XHR / sendBeacon / WebSocket / EventSource / remote import.`,
)
