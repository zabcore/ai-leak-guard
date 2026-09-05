// V1.3 M2 — submit-protection decision UI seam.
//
// Fronts the V1.2 warning modal (`openDocumentModal`) with the
// send-time copy variant instead of building a second component.
// The core hands us a metadata-only `DecisionSummary` (categories +
// counts, NEVER raw values or matched text) and we resolve the
// user's binary choice as a `UserDecision` the core understands.
//
// TRANSIENT ACTIVATION (critical). `openDocumentModal` resolves its
// `outcome` promise SYNCHRONOUSLY inside the button's click handler
// (`finalize`), and this wrapper only `.then`-maps it — no `await`,
// no timer between the user's "Proceed anyway" click and the promise
// resolving. So the core's resume() fires within the same task as
// the proceed-click, keeping the click's user-activation window
// alive for `sendButton.click()`. Do not insert any async step here.
//
// The submit surface reuses the modal in its sensitive view only —
// the scan is a synchronous `detectDetailed` on typed text, so there
// is no "checking…" wait and no unable-to-inspect view (the core's
// Watchdog-A fail-open handles a scan that throws/hangs WITHOUT a
// modal). We open the modal and immediately paint the sensitive
// view in the same task, so the scanning frame never shows.

import { openDocumentModal } from '../document-modal'
import type { DetectorCategory } from '../../detector/types'
import type { DecisionSummary, UserDecision } from './submit-core'

/**
 * Open the send-time warning and resolve the user's decision.
 * `upload-anyway` → `proceed`, `cancel` (button / Escape / × /
 * backdrop) → `return-to-edit`. Never throws; a modal already open
 * (another flow holds it) resolves `cancel` → `return-to-edit`,
 * i.e. the send is held — the safe default.
 */
export function openSubmitDecision(
  summary: DecisionSummary,
  opener: Element | null,
): Promise<UserDecision> {
  const controller = openDocumentModal({
    opener,
    copy: {
      surface: 'message',
      primaryLabel: 'Proceed anyway',
      cancelLabel: 'Return to editing',
    },
  })
  // Paint the terminal view synchronously (same task) so the scanning
  // frame is never seen. Metadata only — counts + categories the core
  // already projected; no text or filenames cross here.
  //
  // V1.3 M4: the summary may carry a FILE dimension so ONE modal covers
  // both the typed message and its attachment (blocker §10.6).
  const file = summary.file
  if (
    file !== undefined &&
    file.status === 'unable-to-inspect' &&
    !summary.messageHasSensitiveText
  ) {
    // File-only send where we couldn't read the attachment and the
    // message text was clean — the honest "couldn't inspect" view, not
    // a "0 sensitive items" sensitive view.
    controller.showUnable({ fileCount: file.fileCount })
  } else {
    // Merge the two dimensions for display: union categories, summed
    // count, either-critical. (The event log does NOT merge — the file
    // is counted once, at attach time; see submit-core §8.)
    const mergedCategories: readonly DetectorCategory[] = file
      ? [...new Set<DetectorCategory>([...summary.categories, ...file.categories])]
      : summary.categories
    controller.showSensitive({
      fileCount: file?.fileCount ?? 1,
      totalMaskable: summary.count + (file?.count ?? 0),
      categories: mergedCategories,
      hasCriticalOrHigh: summary.hadCriticalOrHigh || (file?.hasCriticalOrHigh ?? false),
      attachmentCount: file?.fileCount ?? 0,
      messageHasSensitiveText: summary.messageHasSensitiveText,
      attachmentUnableToInspect: file?.status === 'unable-to-inspect',
    })
  }
  return controller.outcome.then((outcome) =>
    outcome === 'upload-anyway' ? 'proceed' : 'return-to-edit',
  )
}
