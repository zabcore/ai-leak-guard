// V1.3.1 §C monitor — static wiring shared by the probes and the spec.
//
// Pure Node (no Playwright import) so it can be read from anywhere. It
// maps each independently-probeable surface id to its synthetic fixture
// file, and pins the content-free constants the probes use: the
// synthetic sensitive sample, the light-DOM modal host attributes the
// extension mounts (our "the extension intervened" signal), and the
// data-monitor driving hooks the fixtures expose.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * Synthetic, obviously-fake sensitive text. Trips the detector's
 * hasCriticalOrHigh (used verbatim across the shipped submit-adapter
 * unit tests), so the extension must warn on paste / send / file.
 */
export const SENSITIVE_TEXT = 'Patient SSN is 123-45-6789'

/** A synthetic sensitive file for the document (file-upload) probe. */
export const SENSITIVE_FILE = {
  name: 'note.txt',
  type: 'text/plain',
  body: SENSITIVE_TEXT,
} as const

/** Light-DOM host attributes the extension's modals mount under. */
export const MODAL_HOST = {
  /** Paste "preview before send" modal. */
  paste: 'data-ai-leak-guard-preview-modal',
  /** Send-time + document warning modal (shared component). */
  document: 'data-ai-leak-guard-document-modal',
} as const

/** data-monitor hooks every fixture exposes for the harness to drive. */
export const HOOK = {
  composer: '[data-monitor="composer"]',
  send: '[data-monitor="send"]',
  file: '[data-monitor="file"]',
} as const

/** Fixture file per independently-probeable surface id. */
const FIXTURE_FILE: Record<string, string> = {
  chatgpt: 'fixtures/chatgpt.html',
  claude: 'fixtures/claude.html',
  gemini: 'fixtures/gemini.html',
  'copilot-personal': 'fixtures/copilot-personal.html',
  perplexity: 'fixtures/perplexity.html',
}

/** True when a synthetic fixture exists for this surface id. */
export function hasFixture(id: string): boolean {
  return id in FIXTURE_FILE
}

/** Read the fixture HTML for a surface id (throws if none is registered). */
export function fixtureHtml(id: string): string {
  const rel = FIXTURE_FILE[id]
  if (rel === undefined) throw new Error(`No monitor fixture registered for surface "${id}"`)
  return readFileSync(resolve(HERE, rel), 'utf8')
}

/**
 * The navigation URL for a surface: the first coverage origin with its
 * trailing `/*` match suffix turned into a real path. In dry-run every
 * request to the surface's origins is fulfilled with the fixture, so the
 * exact path only has to be inside the origin.
 */
export function navigationUrl(origins: readonly string[]): string {
  const first = origins[0]
  return first.replace(/\*$/, '')
}

/**
 * A live-noauth ROUTE — a surface × state the drift monitor exercises WITHOUT a
 * login. Unlike the fixtures, these `data-monitor` hooks do not exist on the
 * real site, so we key on the real composer selectors the shipped adapters
 * match (kept in sync with `src/content/adapters/*`); the first that appears is
 * driven. Surfaces that require a login (Gemini, Copilot) are absent — they
 * belong to the future authenticated mode.
 *
 * `kind`:
 *   • 'required' — must PASS live; its status counts as live-pass evidence.
 *   • 'gap'      — a known state we cannot deterministically exercise live
 *                  (the Claude pre-hydration flash behind a login). Recorded as
 *                  a GAP, NEVER asserted as a PASS, and covered offline by a
 *                  dry regression fixture instead.
 */
export type LiveNoauthKind = 'required' | 'gap'

export interface LiveNoauthRoute {
  /** Stable per-route key for the status store (surface × state). */
  readonly routeKey: string
  readonly surface: string
  /** Real logged-out URL to navigate. */
  readonly url: string
  /** Real composer selectors to try in order; the first present is driven. */
  readonly composerSelectors: readonly string[]
  readonly kind: LiveNoauthKind
  readonly note?: string
}

export const LIVE_NOAUTH_ROUTES: readonly LiveNoauthRoute[] = [
  {
    routeKey: 'chatgpt:live-noauth',
    surface: 'chatgpt',
    url: 'https://chatgpt.com/',
    // The logged-out fallback <textarea name="prompt-textarea"> is the state
    // that leaked (v1.3.2); the ProseMirror #prompt-textarea appears once hydrated.
    // V1.3.3: the current logged-out FORM composer first (the drift that was
    // reading UNCLASSIFIED), then the v1.3.2 fallback textarea + hydrated div.
    composerSelectors: [
      'textarea#mobile-composer-prompt',
      'textarea[name="prompt"]',
      'textarea[name="prompt-textarea"]',
      '#prompt-textarea',
    ],
    kind: 'required',
  },
  {
    routeKey: 'perplexity:live-noauth',
    surface: 'perplexity',
    url: 'https://www.perplexity.ai/',
    composerSelectors: ['textarea[placeholder*="Ask"]', '#ask-input'],
    kind: 'required',
  },
  {
    routeKey: 'claude:pre-hydration',
    surface: 'claude',
    url: 'https://claude.ai/',
    // Pre-hydration static composer only. It is a brief flash behind a login,
    // not reliably reachable live → recorded as a GAP, covered offline by the
    // claude-static.html dry fixture.
    composerSelectors: ['textarea#static-composer-input'],
    kind: 'gap',
    note: 'pre-hydration flash behind login; covered offline by fixtures/claude-static.html',
  },
]

/** Route keys that must PASS live to count as release evidence. */
export const REQUIRED_LIVE_ROUTES: readonly string[] = LIVE_NOAUTH_ROUTES.filter(
  (r) => r.kind === 'required',
).map((r) => r.routeKey)

/**
 * A leaked-composer DRY regression: reproduce the exact DOM that leaked so the
 * loaded extension's handling is covered deterministically offline (the live
 * states are not reliably reproducible in CI).
 */
export interface LeakedComposerFixture {
  readonly id: string
  /** Origin glob to serve the fixture at (dry-run interception). */
  readonly origin: string
  /** Fixture file relative to `monitor/`. */
  readonly fixtureFile: string
  /** The real composer selector to paste into (must match a shipped adapter). */
  readonly composerSelector: string
}

export const LEAKED_COMPOSER_FIXTURES: readonly LeakedComposerFixture[] = [
  {
    id: 'chatgpt-logged-out-fallback',
    origin: 'https://chatgpt.com/*',
    fixtureFile: 'fixtures/chatgpt-fallback.html',
    composerSelector: 'textarea[name="prompt-textarea"]',
  },
  {
    // V1.3.3 RELEASE BLOCKER: the current logged-out FORM composer.
    id: 'chatgpt-logged-out-form',
    origin: 'https://chatgpt.com/*',
    fixtureFile: 'fixtures/chatgpt-loggedout-form.html',
    composerSelector: 'textarea#mobile-composer-prompt',
  },
  {
    id: 'claude-pre-hydration-static',
    origin: 'https://claude.ai/*',
    fixtureFile: 'fixtures/claude-static.html',
    composerSelector: 'textarea#static-composer-input',
  },
]

/** Read any fixture file by its `monitor/`-relative path. */
export function readFixtureFile(relPath: string): string {
  return readFileSync(resolve(HERE, relPath), 'utf8')
}
