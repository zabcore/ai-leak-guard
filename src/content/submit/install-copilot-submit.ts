// V1.3.1 — wire the NO-RESUME Copilot send adapter.
//
// Copilot cannot be resumed programmatically (untrusted click → CAPTCHA),
// so it does NOT use the shared `installSubmitProtection` /
// `SubmitCore` path the other three sites use — that path builds a core
// whose whole job is to resume the send. This adapter is self-contained:
// it blocks a flagged native send, warns, and lets the user re-press
// Send themselves. This installer just constructs and attaches it, gated
// on the same flag/master predicates as the others.

import { CopilotNoResumeAdapter } from './adapters/copilot-noresume'
import type { InstallSubmitOptions } from './install-submit'

export interface InstalledCopilotSubmit {
  readonly adapter: CopilotNoResumeAdapter
}

/** Construct + attach the Copilot no-resume submit protection. */
export function installCopilotSubmitProtection(opts: InstallSubmitOptions): InstalledCopilotSubmit {
  const adapter = new CopilotNoResumeAdapter({
    isMasterEnabled: opts.isMasterEnabled,
    isFlagEnabled: opts.isFlagEnabled,
  })
  adapter.attach()
  return { adapter }
}
