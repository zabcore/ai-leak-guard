// V1.3 M3 — wire the submit-scan core to Claude (claude.ai). Thin
// wrapper over the shared `installSubmitProtection` helper; see it for
// the wiring. Called from the content script for Claude only, behind
// the flag.

import { ClaudeSubmitAdapter } from './adapters/claude'
import {
  installSubmitProtection,
  type InstallSubmitOptions,
  type InstalledSubmit,
} from './install-submit'

/** Construct + attach the Claude submit protection. */
export function installClaudeSubmitProtection(opts: InstallSubmitOptions): InstalledSubmit {
  const adapter = new ClaudeSubmitAdapter({
    isMasterEnabled: opts.isMasterEnabled,
    isFlagEnabled: opts.isFlagEnabled,
  })
  return installSubmitProtection(adapter, 'claude', opts.isFlagEnabled)
}
