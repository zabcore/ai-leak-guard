// V1.3.1 §D — the ONE machine-readable coverage definition.
//
// Single source of truth for what the product protects, on which
// surface, by which input path. The extension, self-test, and (later)
// the compatibility monitor READ this; website/store copy is checked
// against it. It is PACKAGED with the extension and read LOCALLY via a
// static import — NEVER fetched remotely, no remote config.
//
// Every flag below is DERIVED FROM SHIPPED CODE, not aspiration:
//   • paste     — a site adapter exists (src/content/adapters/*) and the
//                 window-capture paste flow runs for it.
//   • document  — the surface is in `DOCUMENT_PROTECTION_SITES`
//                 (src/content/index.ts): pre-upload interception only.
//                 A send-time file warning does NOT count as document.
//   • send      — a submit adapter is installed for the surface
//                 (`SUBMIT_ADAPTER_SITES` resume path, or the Copilot
//                 no-resume install). `sendMode` names how.
// If a flag isn't proven by shipped code it is `unvalidated` with a
// limitation — never claimed.
//
// Personal Copilot and M365 Copilot are SEPARATE entries even though
// they share the `copilot.cloud.microsoft` host: the extension cannot
// tell them apart by origin, and only the personal path is validated.

export type SupportState = 'supported' | 'unsupported' | 'unvalidated'
export type DocumentState = 'supported' | 'unsupported'
export type SendMode = 'resume' | 'no-resume-two-press' | null

/** A single supported input route id (paste / file / send). */
export type InputRoute =
  | 'paste-text'
  | 'file-change'
  | 'file-drop'
  | 'file-paste'
  | 'file-picker'
  | 'send-enter'
  | 'send-button'

export interface SurfaceCoverage {
  readonly id: string
  readonly label: string
  /** Exact host/path match strings as used in the manifest / adapters. */
  readonly origins: readonly string[]
  readonly paste: SupportState
  readonly send: SupportState
  readonly sendMode: SendMode
  readonly document: DocumentState
  readonly inputRoutes: readonly InputRoute[]
  readonly limitations: readonly string[]
  readonly appliesInVersion: string
}

export interface DetectionKindCoverage {
  readonly label: string
  readonly maskToken: string
  readonly caughtWhen: readonly string[]
  readonly notCaught: readonly string[]
}

export interface DetectionCoverage {
  readonly names: DetectionKindCoverage
  readonly dob: DetectionKindCoverage & { readonly formats: readonly string[] }
}

export interface Coverage {
  readonly coverageVersion: number
  /** Release the coverage applies to. */
  readonly appliesInVersion: string
  readonly surfaces: readonly SurfaceCoverage[]
  readonly detection: DetectionCoverage
}

const APPLIES = '1.3.1'

const RAW: Coverage = {
  coverageVersion: 1,
  appliesInVersion: APPLIES,
  surfaces: [
    {
      id: 'chatgpt',
      label: 'ChatGPT',
      origins: ['https://chatgpt.com/*', 'https://chat.openai.com/*'],
      paste: 'supported',
      send: 'supported',
      sendMode: 'resume',
      document: 'supported',
      inputRoutes: [
        'paste-text',
        'file-change',
        'file-drop',
        'file-paste',
        'file-picker',
        'send-enter',
        'send-button',
      ],
      limitations: [
        'Programmatic sends that bypass Enter and the Send button (suggestion chips, Regenerate, voice auto-submit) are not intercepted.',
      ],
      appliesInVersion: APPLIES,
    },
    {
      id: 'claude',
      label: 'Claude',
      origins: ['https://claude.ai/*'],
      paste: 'supported',
      send: 'supported',
      sendMode: 'resume',
      document: 'supported',
      inputRoutes: [
        'paste-text',
        'file-change',
        'file-drop',
        'file-paste',
        'file-picker',
        'send-enter',
        'send-button',
      ],
      limitations: [
        'Programmatic sends that bypass Enter and the Send button (suggestion/example chips, Retry, edit-and-resend) are not intercepted.',
      ],
      appliesInVersion: APPLIES,
    },
    {
      id: 'gemini',
      label: 'Gemini',
      origins: ['https://gemini.google.com/*'],
      paste: 'supported',
      send: 'supported',
      sendMode: 'resume',
      document: 'supported',
      inputRoutes: [
        'paste-text',
        'file-change',
        'file-drop',
        'file-paste',
        'file-picker',
        'send-enter',
        'send-button',
      ],
      limitations: [
        'Programmatic sends that bypass Enter and the Send button (suggestion chips, regenerate/modify, voice/Deep Research) are not intercepted.',
        'Send-button click interception uses a locale-independent handle; Enter-to-send is locale-safe on all UIs.',
      ],
      appliesInVersion: APPLIES,
    },
    {
      id: 'copilot-personal',
      label: 'Microsoft Copilot (personal)',
      // Shares the host with M365 Copilot; copilot.microsoft.com redirects
      // to copilot.cloud.microsoft.
      origins: ['https://copilot.cloud.microsoft/*', 'https://copilot.microsoft.com/*'],
      paste: 'supported',
      send: 'supported',
      // Copilot rejects an untrusted programmatic click with a CAPTCHA, so
      // a flagged send is BLOCKED + warned; the user presses Send again.
      sendMode: 'no-resume-two-press',
      document: 'unsupported',
      inputRoutes: ['paste-text', 'send-enter', 'send-button'],
      limitations: [
        'Document (pre-upload) protection is not available on Copilot (deferred) — never claim Copilot document coverage.',
        'Send uses a no-resume two-press flow: on a flagged message the native send is blocked and warned; the user presses Send again to proceed.',
      ],
      appliesInVersion: APPLIES,
    },
    {
      id: 'copilot-m365',
      label: 'Microsoft 365 Copilot (work)',
      // Same host as personal Copilot; the extension cannot distinguish a
      // licensed M365 account by origin.
      origins: ['https://copilot.cloud.microsoft/*'],
      paste: 'unvalidated',
      send: 'unsupported',
      sendMode: null,
      document: 'unsupported',
      inputRoutes: [],
      limitations: [
        'Shares the copilot.cloud.microsoft host with personal Copilot; the extension cannot tell a licensed M365 account apart by origin.',
        'Paste is unvalidated — it needs a licensed-account probe (the M365 composer/DOM and enterprise DLP are unverified); do not claim paste coverage until proven.',
        'Send and document protection are not available.',
      ],
      appliesInVersion: APPLIES,
    },
    {
      id: 'perplexity',
      label: 'Perplexity',
      origins: ['https://www.perplexity.ai/*'],
      paste: 'supported',
      send: 'unsupported',
      sendMode: null,
      document: 'supported',
      inputRoutes: ['paste-text', 'file-change', 'file-drop', 'file-paste', 'file-picker'],
      limitations: [
        'Send-time protection is not expanded to Perplexity this release; paste and pre-upload document protection apply.',
      ],
      appliesInVersion: APPLIES,
    },
  ],
  detection: {
    names: {
      label: 'Person Name',
      maskToken: '[PERSON_NAME]',
      caughtWhen: [
        'an explicit patient-side label (colon optional for a "<label> Name" form)',
        'an honorific followed by a surname (Mrs./Mr./Ms./Miss/Mx.)',
        'a name immediately adjacent to a strong identifier (MRN/SSN/DOB/Member ID/…)',
      ],
      notCaught: [
        'a bare name in free prose with no label, title, or adjacent identifier — on-device name recognition (NER) is out of scope this release',
      ],
    },
    dob: {
      label: 'Date of Birth',
      maskToken: '[DOB]',
      caughtWhen: [
        'a birth label (DOB / D.O.B. / Date of Birth / Birth Date / Birthdate / born / born on) followed by a valid date',
      ],
      formats: [
        'numeric MM/DD/YYYY and DD/MM/YYYY (ambiguous values accepted and protected, never converted)',
        'ISO YYYY-MM-DD',
        'written English month names, abbreviated and full, in month-first and day-first order',
      ],
      notCaught: [
        'unlabelled dates (appointments, meetings)',
        'calendar-invalid dates',
        'a bare year with no full date',
      ],
    },
  },
}

/** Deep-freeze so the packaged coverage is immutable at runtime. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value)) deepFreeze(v)
    Object.freeze(value)
  }
  return value
}

/** The frozen, packaged coverage definition. Read locally; never fetched. */
export const COVERAGE: Coverage = deepFreeze(RAW)

/** Stable surface ids, in declaration order. */
export const COVERAGE_SURFACE_IDS: readonly string[] = COVERAGE.surfaces.map((s) => s.id)

/** Look up a surface's coverage by id. */
export function getSurfaceCoverage(id: string): SurfaceCoverage | undefined {
  return COVERAGE.surfaces.find((s) => s.id === id)
}

/** True when the surface makes the given claim (used by the copy checklist / consumers). */
export function surfaceSupports(id: string, channel: 'paste' | 'send' | 'document'): boolean {
  const s = getSurfaceCoverage(id)
  if (s === undefined) return false
  return s[channel] === 'supported'
}
