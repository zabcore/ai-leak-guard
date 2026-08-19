// V1.2 A1 orchestration for the document-protection flow.
//
// Given an already-extracted `ExtractedFiles`, this module:
//   1. Runs the (stub) inspector.
//   2. Opens the placeholder confirm modal.
//   3. On `upload-anyway`, releases the ORIGINAL files back to the host
//      via `upload-release.ts`.
//   4. On `cancel`, clears any origin file input and drops the files
//      (they were never read, only referenced).
//
// Kept separate from `index.ts` so the state machine is unit-testable
// with fabricated events and a stubbed modal.

import type { ExtractedFiles } from './file-extraction'
import { inspectFiles, type FileInspection } from './file-inspector'
import { showDocumentModal, type DocumentModalOutcome } from './document-modal'
import { clearFileInput, releaseFiles, type ReleaseOutcome } from './upload-release'

export type HoldResult =
  | {
      readonly outcome: 'upload-anyway'
      readonly release: ReleaseOutcome
      /**
       * Extraction results per file, in the same order as
       * `state.files`. A3 will read `.extraction.text` from each
       * entry to run detection. In A2 the entries always carry
       * `findings: []`.
       */
      readonly inspection: FileInspection
    }
  | { readonly outcome: 'cancel'; readonly inspection: FileInspection }

/**
 * Injectable seams so the orchestrator can be unit-tested without
 * touching the DOM. Production wiring passes the real Shadow-DOM modal
 * and release helpers; tests substitute in-memory fakes.
 */
export interface HoldDeps {
  readonly showModal: (opts: {
    fileCount: number
    opener: Element | null
  }) => Promise<DocumentModalOutcome>
  readonly releaseFiles: (state: ExtractedFiles) => ReleaseOutcome
  readonly clearInput: (input: HTMLInputElement) => void
}

const defaultDeps: HoldDeps = {
  showModal: (opts) => showDocumentModal(opts),
  releaseFiles,
  clearInput: clearFileInput,
}

/**
 * Hold the intercepted files until the user resolves the modal, then
 * either release them to the host or discard them. The inspector is
 * called for its side-effect-free classification only — the A1 stub
 * always reports zero findings, so the outcome depends entirely on
 * the user's Upload anyway / Cancel choice.
 *
 * @param state         The files pulled off the intercepted event.
 * @param opener        The element that had focus at intercept time.
 *                      Focus returns here after the modal closes.
 * @param deps          Test seam; production passes `defaultDeps`.
 */
export async function holdFiles(
  state: ExtractedFiles,
  opener: Element | null,
  deps: HoldDeps = defaultDeps,
): Promise<HoldResult> {
  // A2: kick off extraction CONCURRENTLY with the modal open so the
  // user sees the confirm dialog immediately instead of waiting up
  // to `EXTRACTION_TIMEOUT_MS` per file for the parse. `inspectFiles`
  // never rejects; hostile files land as
  // `extraction.status === 'unable_to_inspect'`. We await both
  // promises before returning so the caller (and A3, once it wires
  // detection over the extracted text) has the inspection in hand.
  //
  // Detection is still stubbed (`findings: []`) — plugged in by A3.
  const inspectionPromise = inspectFiles(state.files)
  const outcome = await deps.showModal({
    fileCount: state.files.length,
    opener,
  })

  const inspection = await inspectionPromise

  if (outcome === 'upload-anyway') {
    const release = deps.releaseFiles(state)
    return { outcome, release, inspection }
  }

  // Cancel: for a change event, clear the origin input so the site
  // sees no selection at all. For drop / paste we already prevented
  // the default in the content-script handler and there is nothing
  // else to reset.
  if (state.kind === 'change' && state.originInput !== null) {
    deps.clearInput(state.originInput)
  }
  return { outcome: 'cancel', inspection }
}
