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
import { inspectFiles } from './file-inspector'
import { showDocumentModal, type DocumentModalOutcome } from './document-modal'
import { clearFileInput, releaseFiles, type ReleaseOutcome } from './upload-release'

export type HoldResult =
  | { readonly outcome: 'upload-anyway'; readonly release: ReleaseOutcome }
  | { readonly outcome: 'cancel' }

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
  // A1: inspector is a stub. Called for shape only; findings are always
  // empty. Kept in the flow so A2 can plug the real inspector into the
  // same seam without touching this orchestrator.
  inspectFiles(state.files)

  const outcome = await deps.showModal({
    fileCount: state.files.length,
    opener,
  })

  if (outcome === 'upload-anyway') {
    const release = deps.releaseFiles(state)
    return { outcome, release }
  }

  // Cancel: for a change event, clear the origin input so the site
  // sees no selection at all. For drop / paste we already prevented
  // the default in the content-script handler and there is nothing
  // else to reset.
  if (state.kind === 'change' && state.originInput !== null) {
    deps.clearInput(state.originInput)
  }
  return { outcome: 'cancel' }
}
