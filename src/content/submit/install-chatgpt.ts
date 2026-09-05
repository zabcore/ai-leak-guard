// V1.3 M2/M3 — wire the submit-scan core to ChatGPT. Thin wrapper over
// the shared `installSubmitProtection` helper; see it for the wiring.
// Called from the content script for ChatGPT only, behind the flag.

import { ChatGptSubmitAdapter } from './adapters/chatgpt'
import {
  installSubmitProtection,
  type InstallSubmitOptions,
  type InstalledSubmit,
} from './install-submit'

export type { InstallSubmitOptions as InstallChatGptSubmitOptions }
export type { InstalledSubmit as InstalledChatGptSubmit }

/** Construct + attach the ChatGPT submit protection. */
export function installChatGptSubmitProtection(opts: InstallSubmitOptions): InstalledSubmit {
  const adapter = new ChatGptSubmitAdapter({
    isMasterEnabled: opts.isMasterEnabled,
    isFlagEnabled: opts.isFlagEnabled,
  })
  return installSubmitProtection(adapter, 'chatgpt', opts.isFlagEnabled)
}
