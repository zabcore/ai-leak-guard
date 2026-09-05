// V1.3 M5 — "Report this" URL builder (extension side of A-5).
//
// On a failed / unsupported self-test the popup offers a "Report this"
// button that opens the zabcore.com support page prefilled with a STRICT
// ALLOWLIST of content-free diagnostics. The extension SENDS nothing —
// it only opens the page; the user reviews/edits/submits there.
//
// The endpoint + param builder live behind this single module (mirroring
// how the welcome URL is centralized in the service worker) so Track A
// (the website) only has to coordinate one path/param contract.
//
// PRIVACY INVARIANT (audit-enforced): the builder emits ONLY the
// allowlisted keys below. It never forwards composer text, filenames,
// PHI, detector findings, identifiers, or the full user-agent string —
// even if such fields are handed to it. `buildSelfTestReportUrl` reads
// named fields only, so anything extra on the input is dropped by
// construction; a test passes junk fields and asserts they never appear.

/** Support endpoint. Track A owns the final path; this is the only place to update it. */
export const SELF_TEST_REPORT_ENDPOINT = 'https://zabcore.com/self-test-report'

/** The complete allowlist. Nothing outside these keys reaches the URL. */
export interface SelfTestReportInput {
  /** Site id, e.g. 'chatgpt' | 'claude' | 'gemini'. */
  readonly site: string
  /** Extension version from the manifest, e.g. '1.2.1'. */
  readonly ext: string
  /** Submit-adapter id. */
  readonly adapter: string
  /** 'confirmed' | 'fail' | 'unsupported'. */
  readonly result: string
  /** Diagnostic code, e.g. 'NO_MODAL'. */
  readonly code: string
  /** Was a composer resolved? 0/1. */
  readonly composer: 0 | 1
  /** Did interception fire? 0/1. */
  readonly intercept: 0 | 1
  /** Did the warning modal appear? 0/1. */
  readonly modal: 0 | 1
  /** Coarse browser `name/major` only (see `coarseBrowser`) — NOT the full UA. */
  readonly browser: string
  /** ISO-8601 timestamp. */
  readonly ts: string
}

/**
 * Build the prefilled report URL from ONLY the allowlisted params.
 * `src=extension_selftest` is always set so Track A can attribute the
 * source. Extra properties on `input` are ignored — only the ten named
 * fields are read.
 */
export function buildSelfTestReportUrl(input: SelfTestReportInput): string {
  const params = new URLSearchParams()
  params.set('src', 'extension_selftest')
  params.set('site', String(input.site))
  params.set('ext', String(input.ext))
  params.set('adapter', String(input.adapter))
  params.set('result', String(input.result))
  params.set('code', String(input.code))
  params.set('composer', input.composer === 1 ? '1' : '0')
  params.set('intercept', input.intercept === 1 ? '1' : '0')
  params.set('modal', input.modal === 1 ? '1' : '0')
  params.set('browser', String(input.browser))
  params.set('ts', String(input.ts))
  return `${SELF_TEST_REPORT_ENDPOINT}?${params.toString()}`
}

/** The exact set of query keys `buildSelfTestReportUrl` ever emits (for tests/audit). */
export const SELF_TEST_REPORT_ALLOWED_PARAMS: readonly string[] = [
  'src',
  'site',
  'ext',
  'adapter',
  'result',
  'code',
  'composer',
  'intercept',
  'modal',
  'browser',
  'ts',
]

/**
 * Reduce a full user-agent string to a coarse `Name/Major` token
 * (e.g. `Chrome/128`, `Edge/128`, `Firefox/130`) — never the full UA,
 * which is itself a fingerprinting/identifier surface. Unknown shapes
 * collapse to `'unknown'`.
 */
export function coarseBrowser(ua: string | undefined | null): string {
  if (typeof ua !== 'string' || ua.length === 0) return 'unknown'
  // Order matters: Edge/Opera/Brave masquerade with "Chrome" in the UA,
  // so check the more specific tokens first.
  const patterns: Array<[name: string, re: RegExp]> = [
    ['Edge', /\bEdg(?:e|A|iOS)?\/(\d+)/],
    ['Opera', /\bOPR\/(\d+)/],
    ['Firefox', /\bFirefox\/(\d+)/],
    ['Chrome', /\bChrome\/(\d+)/],
    ['Safari', /\bVersion\/(\d+).*\bSafari\//],
  ]
  for (const [name, re] of patterns) {
    const m = re.exec(ua)
    if (m !== null) return `${name}/${m[1]}`
  }
  return 'unknown'
}
