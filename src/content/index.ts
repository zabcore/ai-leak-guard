import { detectDetailed, isMaskable } from '../detector/engine'
import { mask } from './masker'
import { getAdapterForHost, type SiteAdapter } from './adapters'
import { maskInsertAndNotify } from './paste-flow'
import { undoMask } from './undo'
import { resolveInitialEnabled, createEnabledState } from './enabled-state'
import { getPrefs } from '../shared/storage'
import { buildPreviewSummary } from './preview-flow'
import { showPreviewModal, isPreviewModalOpen } from './preview-modal'

const MIN_TEXT_LENGTH = 8

const adapter = getAdapterForHost(globalThis.location.hostname)

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
  const { text: maskedText, maskedSegments } = mask(originalText, maskable)
  const labels = [...new Set(maskable.map((finding) => finding.label))]
  maskInsertAndNotify(siteAdapter, target, maskedText, maskable, {
    count: maskable.length,
    labels,
    onUndo: () => undoMask(siteAdapter, target, maskedSegments, maskable),
  })
}

document.addEventListener(
  'paste',
  (event: ClipboardEvent): void => {
    try {
      if (!enabledState.isEnabled()) return

      const text = event.clipboardData?.getData('text/plain') ?? ''
      if (text.length < MIN_TEXT_LENGTH) return

      const target = event.target as Element | null
      if (target === null || !adapter.isPromptInput(target)) return

      // V1.1 PR 4: preview-before-send. If a preview modal is already open
      // from an earlier paste, drop this event on the floor — the spec is
      // "additional paste events are ignored until the current modal
      // resolves." preventDefault so the site doesn't insert the second
      // paste behind the modal.
      if (isPreviewModalOpen()) {
        event.preventDefault()
        event.stopPropagation()
        return
      }

      // Decision is driven entirely by the engine's `hasCriticalOrHigh`. On
      // clean input (or context-only LOW findings), the modal never opens
      // and the native paste is allowed to proceed byte-for-byte.
      const { findings, hasCriticalOrHigh } = detectDetailed(text)
      if (!hasCriticalOrHigh) return

      event.preventDefault()
      event.stopPropagation()

      const summary = buildPreviewSummary(text, findings)
      void showPreviewModal({ summary, opener: target }).then((outcome) => {
        if (outcome === 'protected') {
          protectedPaste(target, text, adapter)
          return
        }
        if (outcome === 'as-is') {
          insertRaw(target, text)
          return
        }
        // Cancel: insert nothing. Focus was already returned to `target` by
        // the modal on close, so the input is ready for the next keystroke.
      })
    } catch (err) {
      // Never break the user's paste flow; on any error let the original through.
      console.error('[AI Leak Guard] paste handler error:', err)
    }
  },
  true, // capture phase: run before the site's own handlers
)
