// V1.3 M5 / V1.3.1 §E — "Report this" diagnostics: the single source of
// truth for what the self-test report may EVER share.
//
// The extension SENDS nothing. It shows the user a preview of these
// content-free fields, then (default path) copies them as a pasteable
// block and opens a FIXED report page carrying no run data — the user
// pastes and submits. A legacy URL-prefill builder is kept behind an
// owner override; its params are 100% content-free too.
//
// PRIVACY INVARIANT (audit-enforced): every output — the URL, the
// pasteable block, and the preview — is derived from ONE normalized
// allowlist object. `normalizeReportInput` reads only named fields and
// COERCES each to a known enum / 0-1 / string, so composer text,
// filenames, PHI, findings, full URLs, exception messages, stacks, or a
// stray `note` can never survive, even if handed in.

/** Support endpoint. Track A owns the final path; this is the only place to update it. */
export const SELF_TEST_REPORT_ENDPOINT = 'https://zabcore.com/self-test-report'

/** Known surface ids (align with the §D coverage file). Personal Copilot and M365 Copilot are SEPARATE. */
export const SELF_TEST_SITES = ['chatgpt', 'claude', 'gemini', 'copilot', 'copilot-m365'] as const
/** Truthful runtime state of the adapter for this surface (distinct from its id). */
export const ADAPTER_STATES = ['ready', 'unsupported', 'unavailable'] as const
/** The step a run reached / failed at. */
export const SELF_TEST_STEPS = ['composer', 'intercept', 'modal', 'ok'] as const
/** Fixed result kinds. */
export const SELF_TEST_RESULTS = ['confirmed', 'fail', 'unsupported'] as const
/** Fixed diagnostic codes. */
export const SELF_TEST_CODES = [
  'OK',
  'NO_COMPOSER',
  'DRAFT_PRESENT',
  'NO_INTERCEPT',
  'NO_MODAL',
  'TIMEOUT',
  'INIT_FAIL',
] as const
/** Known submit-adapter ids. */
export const SELF_TEST_ADAPTERS = [
  'chatgpt',
  'claude',
  'gemini',
  'copilot',
  'copilot-m365',
] as const

/** The complete allowlist input. Nothing outside these keys is ever read. */
export interface SelfTestReportInput {
  readonly site: string
  readonly ext: string
  readonly adapter: string
  /** V1.3.1 §E: truthful runtime state (`ready|unsupported|unavailable`). */
  readonly adapterState?: string
  /** V1.3.1 §E: the step reached/failed (`composer|intercept|modal|ok`). */
  readonly step?: string
  readonly result: string
  readonly code: string
  readonly composer: 0 | 1
  readonly intercept: 0 | 1
  readonly modal: 0 | 1
  /** Coarse browser `Name/Major` only — NOT the full UA. */
  readonly browser: string
  /** ISO-8601 timestamp. */
  readonly ts: string
}

/** The normalized, fully-coerced allowlist — every downstream output reads THIS. */
export interface NormalizedReport {
  readonly site: string
  readonly ext: string
  readonly adapter: string
  readonly adapterState: string
  readonly step: string
  readonly result: string
  readonly code: string
  readonly composer: 0 | 1
  readonly intercept: 0 | 1
  readonly modal: 0 | 1
  readonly browser: string
  readonly ts: string
}

function coerceEnum(value: unknown, allowed: readonly string[], fallback: string): string {
  return typeof value === 'string' && allowed.includes(value) ? value : fallback
}
function coerce01(value: unknown): 0 | 1 {
  return value === 1 || value === '1' ? 1 : 0
}
function coerceString(value: unknown): string {
  // Only primitive strings survive; everything else becomes empty. This
  // is a defence-in-depth net for `ext`/`browser`/`ts` (which are
  // extension-controlled), NOT a channel for free text.
  return typeof value === 'string' ? value : ''
}

/**
 * Read ONLY the allowlisted fields and coerce each to a known value.
 * Extra input properties are ignored by construction; unknown enum
 * values collapse to a safe token instead of passing arbitrary text.
 */
export function normalizeReportInput(input: SelfTestReportInput): NormalizedReport {
  return {
    site: coerceEnum(input.site, SELF_TEST_SITES, 'unknown'),
    ext: coerceString(input.ext),
    adapter: coerceEnum(input.adapter, SELF_TEST_ADAPTERS, 'unknown'),
    adapterState: coerceEnum(input.adapterState, ADAPTER_STATES, 'unavailable'),
    step: coerceEnum(input.step, SELF_TEST_STEPS, 'ok'),
    result: coerceEnum(input.result, SELF_TEST_RESULTS, 'fail'),
    code: coerceEnum(input.code, SELF_TEST_CODES, 'TIMEOUT'),
    composer: coerce01(input.composer),
    intercept: coerce01(input.intercept),
    modal: coerce01(input.modal),
    browser: coerceString(input.browser),
    ts: coerceString(input.ts),
  }
}

/**
 * Legacy URL-prefill builder (owner override). Content-free params only,
 * `src=extension_selftest` for attribution. Default report path uses the
 * fixed page + pasteable block instead (no run data in the URL).
 */
export function buildSelfTestReportUrl(input: SelfTestReportInput): string {
  const n = normalizeReportInput(input)
  const params = new URLSearchParams()
  params.set('src', 'extension_selftest')
  params.set('site', n.site)
  params.set('ext', n.ext)
  params.set('adapter', n.adapter)
  params.set('adapterState', n.adapterState)
  params.set('step', n.step)
  params.set('result', n.result)
  params.set('code', n.code)
  params.set('composer', String(n.composer))
  params.set('intercept', String(n.intercept))
  params.set('modal', String(n.modal))
  params.set('browser', n.browser)
  params.set('ts', n.ts)
  return `${SELF_TEST_REPORT_ENDPOINT}?${params.toString()}`
}

/**
 * The FIXED report page (scope §E default). Carries NO run-specific data
 * — only the attribution `src`. The user pastes the diagnostics block.
 */
export function buildFixedReportUrl(): string {
  return `${SELF_TEST_REPORT_ENDPOINT}?src=extension_selftest`
}

/** The exact set of query keys the URL builders ever emit (for tests/audit). */
export const SELF_TEST_REPORT_ALLOWED_PARAMS: readonly string[] = [
  'src',
  'site',
  'ext',
  'adapter',
  'adapterState',
  'step',
  'result',
  'code',
  'composer',
  'intercept',
  'modal',
  'browser',
  'ts',
]

/** One human-readable field for the preview + the pasteable block. */
export interface ReportField {
  readonly label: string
  readonly value: string
}

/**
 * The ordered, human-readable fields — the SAME normalized allowlist the
 * URL uses. Both the preview UI and the pasteable block render from this,
 * so what the user SEES is exactly what could be shared (no drift).
 */
export function reportFields(input: SelfTestReportInput): readonly ReportField[] {
  const n = normalizeReportInput(input)
  return [
    { label: 'Site', value: n.site },
    { label: 'Surface state', value: n.adapterState },
    { label: 'Adapter', value: n.adapter },
    { label: 'Result', value: n.result },
    { label: 'Failed step', value: n.step },
    { label: 'Code', value: n.code },
    { label: 'Composer detected', value: String(n.composer) },
    { label: 'Interception fired', value: String(n.intercept) },
    { label: 'Warning shown', value: String(n.modal) },
    { label: 'Extension', value: n.ext },
    { label: 'Browser', value: n.browser },
    { label: 'When', value: n.ts },
    { label: 'Source', value: 'extension_selftest' },
  ]
}

/** Truthful adapter runtime state derived from the result kind. */
export function adapterStateForResult(result: string): (typeof ADAPTER_STATES)[number] {
  if (result === 'confirmed') return 'ready'
  if (result === 'unsupported') return 'unsupported'
  return 'unavailable' // 'fail' (and any unknown) → couldn't confirm it works
}

/** The step a run reached / failed at, derived from the diagnostic code. */
export function stepForCode(code: string): (typeof SELF_TEST_STEPS)[number] {
  switch (code) {
    case 'OK':
      return 'ok'
    case 'NO_COMPOSER':
    case 'DRAFT_PRESENT':
      return 'composer'
    case 'NO_INTERCEPT':
    case 'INIT_FAIL':
      return 'intercept'
    case 'NO_MODAL':
    case 'TIMEOUT':
    default:
      return 'modal'
  }
}

/** Render the allowlist as a compact, pasteable, content-free `key: value` block. */
export function buildDiagnosticsBlock(input: SelfTestReportInput): string {
  return reportFields(input)
    .map((f) => `${f.label}: ${f.value}`)
    .join('\n')
}

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
