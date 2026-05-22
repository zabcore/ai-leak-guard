import { detect } from '../detector/engine'
import { RULES } from '../detector/rules'
import { mask } from './masker'
import { showToast } from './toast'
import { getAdapterForHost } from './adapters'
import { incrementCounters, decrementCounters } from '../shared/counter'
import { getPrefs } from '../shared/storage'

const MIN_TEXT_LENGTH = 8

const adapter = getAdapterForHost(window.location.hostname)

// `preventDefault()` on a paste event must run synchronously, so we cannot await
// a storage read inside the handler. Instead we cache the enabled flag and keep
// it live via storage.onChanged, which lets the popup toggle take effect
// immediately without a page reload.
let enabled = true

void getPrefs().then((prefs) => {
  enabled = prefs.enabled
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
      const inserted = adapter.insertText(target, maskedText)
      if (!inserted) {
        document.execCommand('insertText', false, maskedText)
      }

      void incrementCounters(findings)

      const labels = [...new Set(findings.map((finding) => finding.label))]
      showToast({
        count: findings.length,
        labels,
        onUndo: () => {
          adapter.replaceContents(target, text)
          void decrementCounters(findings)
        },
      })
    } catch (err) {
      // Never break the user's paste flow; on any error let the original through.
      console.error('[AI Leak Guard] paste handler error:', err)
    }
  },
  true, // capture phase: run before the site's own handlers
)
