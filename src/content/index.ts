import { detectDetailed, isMaskable } from '../detector/engine'
import { mask } from './masker'
import { getAdapterForHost, type SiteAdapter } from './adapters'
import { maskInsertAndNotify } from './paste-flow'
import { resolveInitialEnabled, createEnabledState } from './enabled-state'
import { getPrefs } from '../shared/storage'
import { buildPreviewSummary } from './preview-flow'
import { showPreviewModal, isPreviewModalOpen } from './preview-modal'
import { captureSelection, restoreSelection } from './selection'
import { isDocumentProtectionEnabled } from './document-flag'
import {
  extractFilesFromChange,
  extractFilesFromDrop,
  extractFilesFromPaste,
} from './file-extraction'
import { holdFiles, type HoldResult } from './document-flow'
import { isDocumentModalOpen } from './document-modal'
import { resolveDocumentDecision } from './document-decision'
import { clearFileInput, consumePassThroughIfArmed } from './upload-release'
import { showReattachNudge } from './document-nudge'
import { installFsaMessageHandler } from './fsa-isolated'
import { appendEvent, type AlgAction, type AlgEvent } from '../shared/event-log'
import type { DetectorCategory, Finding } from '../detector/types'

const MIN_TEXT_LENGTH = 8

const adapter = getAdapterForHost(globalThis.location.hostname)

// V1.2 A1: sites in scope for document interception. Copilot is
// explicitly deferred — the paste-flow adapter still handles Copilot,
// but no file-interception listeners fire there. Fallback (unknown
// host) is also excluded so a stray content-script injection on a
// non-matched page cannot open the document modal.
const DOCUMENT_PROTECTION_SITES: ReadonlySet<string> = new Set([
  'chatgpt',
  'claude',
  'gemini',
  'perplexity',
])
const isDocumentProtectionInScope = DOCUMENT_PROTECTION_SITES.has(adapter.id)

// Default to disabled until the stored preference is confirmed. This avoids
// masking during the brief startup window if the user had turned the extension
// off, and fails closed (stays inactive) if the preference can't be read. A
// live storage.onChanged update (e.g. the popup toggle) wins over a slower
// initial read so the toggle takes effect immediately without a page reload.
const enabledState = createEnabledState(false)

void resolveInitialEnabled(getPrefs).then((value) => {
  enabledState.applyInitial(value)
})

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return
  const change = changes.prefs
  if (change === undefined) return
  const next = change.newValue as { enabled?: unknown } | undefined
  if (next !== undefined && typeof next.enabled === 'boolean') {
    enabledState.applyLiveUpdate(next.enabled)
  }
})

// Inserts arbitrary text through the site adapter (with an execCommand
// fallback). Used for the `Paste as-is` outcome, where we're doing what a
// native paste would do — no toast, no undo, no counter increment.
function insertRaw(target: Element, text: string): boolean {
  return adapter.insertText(target, text) || document.execCommand('insertText', false, text)
}

// V1.2 A5 (#40) metadata-only paste event helper. Same site label
// the document path uses, same never-throws posture. Called only
// from paste-decision terminals where we already have the
// `detectDetailed` result; NEVER re-scans and NEVER receives the
// raw text.
function logPasteEvent(action: AlgAction, findings: readonly Finding[]): void {
  try {
    const maskable = findings.filter(isMaskable)
    const catSet = new Set<DetectorCategory>()
    for (const f of maskable) {
      if (f.category) catSet.add(f.category)
    }
    // `hasCriticalOrHigh` derived from findings — mirrors the same
    // computation `detectDetailed` returns without a re-scan.
    const hadCriticalOrHigh = findings.some(
      (f) => f.effectiveSensitivity === 'critical' || f.effectiveSensitivity === 'high',
    )
    const event: AlgEvent = {
      ts: Date.now(),
      site: adapter.id,
      eventType: 'paste',
      action,
      categories: [...catSet],
      count: maskable.length,
      hadCriticalOrHigh,
    }
    void appendEvent(event)
  } catch (err) {
    // Never let event-log wiring break the paste flow.
    console.warn('[AI Leak Guard] paste event log failed:', err)
  }
}

function protectedPaste(target: Element, originalText: string, siteAdapter: SiteAdapter): void {
  const findings = detectDetailed(originalText).findings
  const maskable = findings.filter(isMaskable)
  if (maskable.length === 0) {
    // Defensive: should not happen because the modal only opens when
    // `hasCriticalOrHigh` is true, which implies at least one maskable
    // finding. Fall back to a raw insert so nothing is silently dropped.
    insertRaw(target, originalText)
    return
  }
  const { text: maskedText } = mask(originalText, maskable)
  const labels = [...new Set(maskable.map((finding) => finding.label))]
  // V1.1 has NO undo path — the preview modal is the single decision
  // point. The confirmation toast is a plain acknowledgement (count +
  // labels), no Undo button.
  maskInsertAndNotify(siteAdapter, target, maskedText, maskable, {
    count: maskable.length,
    labels,
  })
}

// V1.2 A1: is the current call a candidate for the document flow? The
// checks are stacked from cheapest-to-strictest so we bail out fast on
// the common path where the feature is off.
function documentFlowActive(): boolean {
  if (!isDocumentProtectionEnabled()) return false
  if (!isDocumentProtectionInScope) return false
  if (!enabledState.isEnabled()) return false
  return true
}

// After a document-flow hold resolves, act on the outcome:
//   - upload-anyway + released           → nothing extra to do; the
//     original event was replayed and the host is uploading.
//   - upload-anyway + needs-user-reattach → the DataTransfer replay
//     wasn't available (drop / paste / closed-shadow-root); the
//     pass-through-once guard is armed, so we show a small nudge
//     telling the user to re-attach. On drop/paste of a CLEAN file
//     the copy is informational ("no sensitive items found"); on a
//     sensitive/unable file the user actively said "upload anyway"
//     via the modal so the nudge stays a plain re-attach instruction.
//   - cancel                              → nothing was uploaded and
//     the origin input (if any) was already cleared by the flow.
function handleHoldResult(result: HoldResult, kind: 'change' | 'drop' | 'paste'): void {
  if (result.outcome === 'cancel') return
  if (result.release !== 'needs-user-reattach') return
  const wasClean = result.inspection.aggregate.state === 'clean'
  const nudge =
    kind === 'change'
      ? 'Attachment released. Please pick the file again to send it to the site.'
      : kind === 'drop'
        ? wasClean
          ? 'No sensitive items found. Drop the file again to send it to the site.'
          : 'Attachment released. Please drop the file again to send it to the site.'
        : wasClean
          ? 'No sensitive items found. Paste the image again to send it to the site.'
          : 'Attachment released. Please paste the image again to send it to the site.'
  showReattachNudge(nudge)
}

// V1.2 A1.1: FSA (`window.showOpenFilePicker`) picker interception.
// The MAIN-world hook (`src/content/main-world/fsa-hook.ts`, wired as
// a separate content_scripts entry) wraps the picker on the page's
// window and posts `hold-request` metadata over `window.postMessage`;
// this handler owns the flag / modal / decision half of the dance
// and posts a `hold-decision` reply. The MAIN-world wrapper always
// asks — so when the flag is OFF we can answer `upload-anyway`
// immediately and the site sees a byte-for-byte native picker.
installFsaMessageHandler(window, {
  isActive: () => documentFlowActive(),
  isAnotherModalOpen: () => isDocumentModalOpen() || isPreviewModalOpen(),
  resolveDecision: (inspectionPromise, opts) =>
    resolveDocumentDecision(inspectionPromise, { ...opts, siteId: adapter.id }),
})

// One listener on `window` in the capture phase. Two reasons this beats
// site-native paste handlers on ChatGPT-style ProseMirror editors:
//   1. `window` is the outermost target in the DOM event flow — capture on
//      window runs before capture on document / html / body / editor. A
//      site handler attached in capture on document (or any inner element)
//      fires AFTER us, so our stopImmediatePropagation / stopPropagation
//      pair prevents theirs from ever running.
//   2. Combined with `run_at: "document_start"` in the manifest, our
//      listener is registered before the site's app script gets a chance
//      to add its own — even on the same node, capture-phase listeners
//      fire in registration order, so first-in wins on ties.
//
// Without both of these, ChatGPT's ProseMirror captured the paste first,
// inserted the original text through its own model, and our subsequent
// `protectedPaste` insertion landed on top → duplicate paste, original PHI
// still visible.
window.addEventListener(
  'paste',
  (event: ClipboardEvent): void => {
    try {
      if (!enabledState.isEnabled()) return

      // V1.2 A1: file paths first, when the document-protection flag is
      // ON. A pasted image / dropped-into-clipboard file lives in
      // `clipboardData.files`; the V1.1 paste handler only ever read
      // `text/plain`, so those files pass straight through to the host
      // today. When the flag is off this branch is a no-op, preserving
      // that byte-for-byte behavior.
      if (documentFlowActive()) {
        if (consumePassThroughIfArmed('paste')) {
          // Post-Upload-anyway re-paste: let the host see it untouched.
          return
        }
        if (!isDocumentModalOpen() && !isPreviewModalOpen()) {
          const extracted = extractFilesFromPaste(event)
          if (extracted !== null) {
            event.preventDefault()
            event.stopImmediatePropagation()
            event.stopPropagation()
            const target = event.target as Element | null
            void holdFiles(extracted, target, undefined, adapter.id).then((result) => {
              handleHoldResult(result, 'paste')
            })
            return
          }
        }
      }

      const text = event.clipboardData?.getData('text/plain') ?? ''
      if (text.length < MIN_TEXT_LENGTH) return

      const target = event.target as Element | null
      if (target === null || !adapter.isPromptInput(target)) return

      // V1.1 PR 4: preview-before-send. If a preview modal is already open
      // from an earlier paste, drop this event on the floor — the spec is
      // "additional paste events are ignored until the current modal
      // resolves." preventDefault + stopImmediatePropagation so the site
      // doesn't get to insert the second paste behind the modal.
      if (isPreviewModalOpen() || isDocumentModalOpen()) {
        event.preventDefault()
        event.stopImmediatePropagation()
        event.stopPropagation()
        return
      }

      // Decision is driven entirely by the engine's `hasCriticalOrHigh`. On
      // clean input (or context-only LOW findings), the modal never opens
      // and the native paste is allowed to proceed byte-for-byte.
      const { findings, hasCriticalOrHigh } = detectDetailed(text)
      if (!hasCriticalOrHigh) return

      // Stop the browser's default paste AND stop any other listeners
      // (site-level or extension-level) from seeing this event. On ChatGPT
      // this is what prevents ProseMirror from also inserting the original
      // text through its own paste path.
      event.preventDefault()
      event.stopImmediatePropagation()
      event.stopPropagation()

      // Snapshot the selection BEFORE opening the modal — the modal's
      // primary-button focus wipes the editor's document selection, and
      // without this the paste would append at the caret instead of
      // replacing the user's selected text. See src/content/selection.ts.
      const savedRange = captureSelection()

      const summary = buildPreviewSummary(text, findings)
      void showPreviewModal({ summary, opener: target }).then((outcome) => {
        if (outcome === 'protected') {
          restoreSelection(target, savedRange)
          protectedPaste(target, text, adapter)
          logPasteEvent('protected', findings)
          return
        }
        if (outcome === 'as-is') {
          restoreSelection(target, savedRange)
          insertRaw(target, text)
          logPasteEvent('as-is', findings)
          return
        }
        // Cancel: insert nothing. Focus was already returned to `target` by
        // the modal on close, so the input is ready for the next keystroke.
        logPasteEvent('cancelled', findings)
      })
    } catch (err) {
      // Never break the user's paste flow; on any error let the original through.
      console.error('[AI Leak Guard] paste handler error:', err)
    }
  },
  true, // capture phase: run before the site's own handlers
)

// V1.2 A1: file-picker interception. Same window-capture +
// stopImmediatePropagation pattern as paste — see the paste handler
// above for the ordering rationale (window beats document beats editor;
// document_start beats page scripts on the same target). When
// documentFlowActive() returns false — the feature flag is off, the
// site is not in scope, or the user has toggled the extension off —
// this listener is a strict no-op and native change events proceed
// unchanged.
window.addEventListener(
  'change',
  (event: Event): void => {
    try {
      if (!documentFlowActive()) return
      // Post-Upload-anyway replay path: exactly one change event slips
      // through untouched so the host runs its normal upload flow.
      if (consumePassThroughIfArmed('change')) return
      if (isDocumentModalOpen() || isPreviewModalOpen()) {
        // A second file interaction while the first is unresolved is
        // dropped on the floor — same policy as V1.1 paste. Also
        // clear the origin input so the user can re-select the SAME
        // file after the modal closes: browsers suppress the change
        // event when a file input's value is unchanged, so leaving
        // the ignored selection in place would silently swallow the
        // next attempt to attach that same file.
        const t = event.target
        if (t instanceof HTMLInputElement && t.type === 'file') {
          clearFileInput(t)
        }
        event.preventDefault()
        event.stopImmediatePropagation()
        event.stopPropagation()
        return
      }
      const extracted = extractFilesFromChange(event)
      if (extracted === null) return
      event.preventDefault()
      event.stopImmediatePropagation()
      event.stopPropagation()
      const opener = (event.target as Element | null) ?? null
      void holdFiles(extracted, opener, undefined, adapter.id).then((result) => {
        handleHoldResult(result, 'change')
      })
    } catch (err) {
      console.error('[AI Leak Guard] change (file) handler error:', err)
    }
  },
  true,
)

// V1.2 A1: drag-and-drop interception. `preventDefault` on `dragover`
// is required for `drop` to fire on a target in the first place; we
// leave the browser's default alone on dragover so the host's own drop
// zones still light up as the user drags, and only stop propagation on
// the drop itself.
window.addEventListener(
  'drop',
  (event: DragEvent): void => {
    try {
      if (!documentFlowActive()) return
      if (consumePassThroughIfArmed('drop')) return
      if (isDocumentModalOpen() || isPreviewModalOpen()) {
        event.preventDefault()
        event.stopImmediatePropagation()
        event.stopPropagation()
        return
      }
      const extracted = extractFilesFromDrop(event)
      if (extracted === null) return
      event.preventDefault()
      event.stopImmediatePropagation()
      event.stopPropagation()
      const opener = (event.target as Element | null) ?? null
      void holdFiles(extracted, opener, undefined, adapter.id).then((result) => {
        handleHoldResult(result, 'drop')
      })
    } catch (err) {
      console.error('[AI Leak Guard] drop handler error:', err)
    }
  },
  true,
)
