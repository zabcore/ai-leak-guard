// V1.3 M2 — wire the submit-scan core to ChatGPT.
//
// Builds one `SubmitCore` with the ChatGPT decision UI + metadata
// event log, constructs the `ChatGptSubmitAdapter`, and attaches it.
// The adapter's listeners self-gate on the submit flag + master
// toggle + kill switch, so with the flag OFF (the committed default)
// this install is inert: listeners fire but never `preventDefault`,
// so the site's native send is byte-for-byte unchanged.
//
// Called from the content script for ChatGPT only. Kept separate
// from `index.ts` so it is unit-testable without the whole
// content-script module graph.

import { SubmitCore } from './submit-core'
import { ChatGptSubmitAdapter } from './adapters/chatgpt'
import { openSubmitDecision } from './submit-ui'
import type { AlgEvent } from '../../shared/event-log'
import { appendEvent } from '../../shared/event-log'

export interface InstallChatGptSubmitOptions {
  /** Master extension on/off toggle (mirrors the paste path's `enabledState`). */
  readonly isMasterEnabled: () => boolean
  /** Submit-protection flag (default OFF in `main`). */
  readonly isFlagEnabled: () => boolean
}

export interface InstalledChatGptSubmit {
  readonly core: SubmitCore
  readonly adapter: ChatGptSubmitAdapter
}

/**
 * Construct + attach the ChatGPT submit protection. Returns the
 * pieces for diagnostics/tests; production ignores the return value.
 */
export function installChatGptSubmitProtection(
  opts: InstallChatGptSubmitOptions,
): InstalledChatGptSubmit {
  const adapter = new ChatGptSubmitAdapter({
    isMasterEnabled: opts.isMasterEnabled,
    isFlagEnabled: opts.isFlagEnabled,
  })

  const core = new SubmitCore({
    // Site label for the metadata event log — enables `eventType:
    // 'submit'` rows in the activity log for ChatGPT.
    logSiteId: 'chatgpt',
    // The decision UI: the shared warning modal in its send-time
    // copy. `getCurrentOpener()` gives focus somewhere to return to
    // when the modal closes. Resolves synchronously on the user's
    // click so resume() keeps the proceed-click activation window.
    decide: (summary) => openSubmitDecision(summary, adapter.getCurrentOpener()),
    logEvent: (event: AlgEvent) => {
      try {
        void appendEvent(event)
      } catch {
        // Best-effort; never into the flow.
      }
    },
    // `isEnabled` on the core is belt-and-braces with the adapter's
    // own synchronous gate; both read the same flag.
    isEnabled: opts.isFlagEnabled,
  })

  adapter.attach(core)
  return { core, adapter }
}
