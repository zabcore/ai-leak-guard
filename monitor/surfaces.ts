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
