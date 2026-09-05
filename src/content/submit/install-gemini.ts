// V1.3 M3 — wire the submit-scan core to Gemini
// (gemini.google.com). Thin wrapper over the shared
// `installSubmitProtection` helper; see it for the wiring. Called from
// the content script for Gemini only, behind the flag.

import { GeminiSubmitAdapter } from './adapters/gemini'
import {
  installSubmitProtection,
  type InstallSubmitOptions,
  type InstalledSubmit,
} from './install-submit'

/** Construct + attach the Gemini submit protection. */
export function installGeminiSubmitProtection(opts: InstallSubmitOptions): InstalledSubmit {
  const adapter = new GeminiSubmitAdapter({
    isMasterEnabled: opts.isMasterEnabled,
    isFlagEnabled: opts.isFlagEnabled,
  })
  return installSubmitProtection(adapter, 'gemini', opts.isFlagEnabled)
}
