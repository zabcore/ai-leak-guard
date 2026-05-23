import { detect } from '../detector/engine'
import { RULES } from '../detector/rules'
import { mask } from './masker'
import { getAdapterForHost } from './adapters'
import { maskInsertAndNotify } from './paste-flow'
import { undoMask } from './undo'
import { resolveInitialEnabled } from './enabled-state'
import { getPrefs } from '../shared/storage'

const MIN_TEXT_LENGTH = 8

const adapter = getAdapterForHost(window.location.hostname)

// Default to disabled until the stored preference is confirmed. This avoids
// masking during the brief startup window if the user had turned the extension
// off, and fails closed (stays inactive) if the preference can't be read. The
// flag is then kept live via storage.onChanged so the popup toggle takes effect
// immediately without a page reload.
let enabled = false

void resolveInitialEnabled(getPrefs).then((value) => {
  enabled = value
})

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return
  const change = changes.prefs
  if (change === undefined) return
  const next = change.newValue as { enabled?: unknown } | undefined
  if (next !== undefined && typeof next.enabled === 'boolean') {
    enabled = next.enabled
  }
})

document.addEventListener(
  'paste',
  (event: ClipboardEvent): void => {
    try {
      if (!enabled) return

      const text = event.clipboardData?.getData('text/plain') ?? ''
      if (text.length < MIN_TEXT_LENGTH) return

      const target = event.target as Element | null
      if (target === null || !adapter.isPromptInput(target)) return

      const findings = detect(text, RULES)
      if (findings.length === 0) return

      event.preventDefault()
      event.stopPropagation()

      const { text: maskedText } = mask(text, findings)

      // Undo restores the full original paste, which is only safe while the
      // input still holds exactly what we inserted. Once the user edits the
      // input, disable Undo (and say so) rather than clobber their typing.
      // Our own insertion's input event fired synchronously during insertion,
      // before this listener is attached, so it won't trip the dirty check.
      const onUserEdit = (): void => {
        result.handle?.disableUndo()
        target.removeEventListener('input', onUserEdit)
      }

      const labels = [...new Set(findings.map((finding) => finding.label))]
      const result = maskInsertAndNotify(adapter, target, maskedText, findings, {
        count: findings.length,
        labels,
        onUndo: () => {
          void undoMask(adapter, target, text, findings)
        },
        onDismiss: () => {
          target.removeEventListener('input', onUserEdit)
        },
      })

      // Both insertion paths failed: nothing was pasted and no toast shown.
      if (!result.inserted) return

      target.addEventListener('input', onUserEdit)
    } catch (err) {
      // Never break the user's paste flow; on any error let the original through.
      console.error('[AI Leak Guard] paste handler error:', err)
    }
  },
  true, // capture phase: run before the site's own handlers
)
