import { detect, isMaskable } from '../detector/engine'
import { RULES } from '../detector/rules'
import { mask } from './masker'
import { getAdapterForHost } from './adapters'
import { maskInsertAndNotify } from './paste-flow'
import { undoMask } from './undo'
import { resolveInitialEnabled, createEnabledState } from './enabled-state'
import { getPrefs } from '../shared/storage'

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

document.addEventListener(
  'paste',
  (event: ClipboardEvent): void => {
    try {
      if (!enabledState.isEnabled()) return

      const text = event.clipboardData?.getData('text/plain') ?? ''
      if (text.length < MIN_TEXT_LENGTH) return

      const target = event.target as Element | null
      if (target === null || !adapter.isPromptInput(target)) return

      // V1.1: detect() now returns findings enriched with `effectiveSensitivity`.
      // Only CRITICAL/HIGH findings get masked; anything LOW (e.g. clinical
      // context in PR 2) stays visible. Bare-Rule findings without taxonomy
      // fall through `isMaskable` as true, preserving pre-V1.1 behavior.
      const maskable = detect(text, RULES).filter(isMaskable)
      if (maskable.length === 0) return

      event.preventDefault()
      event.stopPropagation()

      const { text: maskedText, maskedSegments } = mask(text, maskable)

      const labels = [...new Set(maskable.map((finding) => finding.label))]
      const result = maskInsertAndNotify(adapter, target, maskedText, maskable, {
        count: maskable.length,
        labels,
        // Undo restores only the placeholder spans (preserving anything typed
        // after the paste) and reports success, so it is always safe to offer —
        // no fragile edit-detection that could wrongly block it when the site
        // fires its own DOM events after insertion.
        onUndo: () => undoMask(adapter, target, maskedSegments, maskable),
      })

      // Both insertion paths failed: nothing was pasted and no toast shown.
      if (!result.inserted) return
    } catch (err) {
      // Never break the user's paste flow; on any error let the original through.
      console.error('[AI Leak Guard] paste handler error:', err)
    }
  },
  true, // capture phase: run before the site's own handlers
)
