// V1.2 A1 orchestration for the document-protection flow.
//
// Given an already-extracted `ExtractedFiles`, this module:
//   1. Kicks off `inspectFiles` (A2 extraction + A3 detection).
//   2. Routes through the A4 decision helper — clean files
//      auto-proceed with NO modal; sensitive / unable_to_inspect
//      open the warning modal in the matching view.
//   3. On `upload-anyway`, releases the ORIGINAL files back to the
//      host via `upload-release.ts`.
//   4. On `cancel`, clears any origin file input and drops the files
//      (they were never read by us for the purpose of returning them
//      — only referenced).
//
// Kept separate from `index.ts` so the state machine is unit-testable
// with fabricated events and a stubbed decision helper.

import type { ExtractedFiles } from './file-extraction'
import { inspectFiles, type FileInspection } from './file-inspector'
import { resolveDocumentDecision } from './document-decision'
import type { DocumentModalOutcome } from './document-modal'
import { clearFileInput, releaseFiles, type ReleaseOutcome } from './upload-release'

export type HoldResult =
  | {
      readonly outcome: 'upload-anyway'
      readonly release: ReleaseOutcome
      readonly inspection: FileInspection
    }
  // Cancel deliberately does NOT carry the inspection. A user who
  // cancels during "Checking…" gets an instant close — we must not
  // block on inspection settling just to attach a value nothing
  // downstream reads.
  | { readonly outcome: 'cancel' }

/**
 * Injectable seams so the orchestrator can be unit-tested without
 * touching the DOM. Production wiring passes the real decision helper
 * and release helpers; tests substitute in-memory fakes.
 */
export interface HoldDeps {
  readonly resolveDecision: (
    inspectionPromise: Promise<FileInspection>,
    opts: { readonly opener: Element | null },
  ) => Promise<DocumentModalOutcome>
  readonly releaseFiles: (state: ExtractedFiles) => ReleaseOutcome
  readonly clearInput: (input: HTMLInputElement) => void
}

const defaultDeps: HoldDeps = {
  resolveDecision: resolveDocumentDecision,
  releaseFiles,
  clearInput: clearFileInput,
}

/**
 * Hold the intercepted files until the user's decision resolves,
 * then either release them to the host or discard them. Clean files
 * skip the modal entirely and auto-release; sensitive / unable
 * inspections warn before the release.
 */
export async function holdFiles(
  state: ExtractedFiles,
  opener: Element | null,
  deps: HoldDeps = defaultDeps,
): Promise<HoldResult> {
  // Kick off extraction + detection concurrently with the decision
  // helper so the "Checking…" state can paint immediately on a slow
  // scan (and skip entirely on a fast one).
  const inspectionPromise = inspectFiles(state.files)
  const outcome = await deps.resolveDecision(inspectionPromise, { opener })

  if (outcome === 'cancel') {
    // Instant cancel: don't await inspectionPromise. A user who hit
    // Cancel during "Checking…" would otherwise wait for extraction
    // to run to completion (multi-second on a PDF) before this flow
    // clears the input and returns. The unused inspection promise is
    // allowed to fall to the floor — its refs drop as soon as it
    // settles.
    if (state.kind === 'change' && state.originInput !== null) {
      deps.clearInput(state.originInput)
    }
    return { outcome: 'cancel' }
  }

  // upload-anyway: we're going to release, so inspection has already
  // settled (the modal only shows the [Upload anyway] button once the
  // scan completes) — this await is a formality.
  const inspection = await inspectionPromise
  const release = deps.releaseFiles(state)
  return { outcome, release, inspection }
}
