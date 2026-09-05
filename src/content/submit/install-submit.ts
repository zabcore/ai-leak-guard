// V1.3 M3 — shared submit-protection install helper.
//
// M2 inlined this in `install-chatgpt.ts`. M3 factors the identical
// core/decision-UI/event-log wiring into one place so each site's
// install file is just "which adapter, which log label." The adapter's
// listeners self-gate on the submit flag + master toggle + kill switch,
// so with the flag OFF (the committed default) every install is inert:
// listeners fire but never `preventDefault`, and the site's native send
// is byte-for-byte unchanged.

import { SubmitCore } from './submit-core'
import { openSubmitDecision } from './submit-ui'
import type { BaseSubmitAdapter } from './adapters/base-submit-adapter'
import type { AlgEvent } from '../../shared/event-log'
import { appendEvent } from '../../shared/event-log'

export interface InstallSubmitOptions {
  /** Master extension on/off toggle (mirrors the paste path's `enabledState`). */
  readonly isMasterEnabled: () => boolean
  /** Submit-protection flag (default OFF in `main`). */
  readonly isFlagEnabled: () => boolean
}

export interface InstalledSubmit {
  readonly core: SubmitCore
  readonly adapter: BaseSubmitAdapter
}

/**
 * Build one `SubmitCore` (decision UI = the shared send-time warning
 * modal, metadata-only event log tagged `logSiteId`) and attach the
 * given adapter. `isFlagEnabled` MUST be the same predicate the adapter
 * was constructed with: the adapter gates interception on it, and the
 * core gates resume on it, so passing them the same source keeps
 * "blocked the native send" and "will resume it" in lockstep. Returns
 * the pieces for diagnostics/tests; production ignores the return value.
 */
export function installSubmitProtection(
  adapter: BaseSubmitAdapter,
  logSiteId: string,
  isFlagEnabled: () => boolean,
): InstalledSubmit {
  const core = new SubmitCore({
    // Site label for the metadata event log — enables `eventType:
    // 'submit'` rows in the activity log for this site.
    logSiteId,
    // The decision UI: the shared warning modal in its send-time copy.
    // `getCurrentOpener()` gives focus somewhere to return to when the
    // modal closes. Resolves synchronously on the user's click so
    // resume() keeps the proceed-click activation window.
    decide: (summary) => openSubmitDecision(summary, adapter.getCurrentOpener()),
    logEvent: (event: AlgEvent) => {
      try {
        void appendEvent(event)
      } catch {
        // Best-effort; never into the flow.
      }
    },
    // Belt-and-braces with the adapter's own synchronous gate; both
    // read the SAME flag so they can't disagree.
    isEnabled: isFlagEnabled,
  })

  adapter.attach(core)
  return { core, adapter }
}
