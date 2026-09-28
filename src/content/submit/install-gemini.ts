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
import { installSendBridge } from './send-bridge'

/**
 * Construct + attach the Gemini submit protection, plus the V1.3.5 MAIN-world
 * Enter-reclaim bridge. Gemini installs an earliest page-world capture Enter
 * handler that `stopImmediatePropagation`s, so our isolated `keydown` listener
 * never sees Enter; the bridge lets the `send-capture.ts` shim (which wins that
 * race in the page world) drive the same flow. Button-click sends still go
 * through the isolated `click` path unchanged.
 */
export function installGeminiSubmitProtection(opts: InstallSubmitOptions): InstalledSubmit {
  const adapter = new GeminiSubmitAdapter({
    isMasterEnabled: opts.isMasterEnabled,
    isFlagEnabled: opts.isFlagEnabled,
  })
  const installed = installSubmitProtection(adapter, 'gemini', opts.isFlagEnabled)
  // Arm + bridge the MAIN-world shim. Best-effort: if the page has no window
  // (it always does here) or messaging fails, the button-click path still works.
  try {
    installSendBridge({ onSendIntent: () => adapter.handleExternalSendIntent() })
  } catch {
    // never break install
  }
  return installed
}
