import type { Finding } from '../detector/types'
import type { SiteAdapter } from './adapters/base'
import { incrementCounters } from '../shared/counter'
import { showToast, type ToastHandle, type ToastOptions } from './toast'

export interface MaskInsertResult {
  inserted: boolean
  handle: ToastHandle | null
}

// Inserts the masked text (site adapter first, execCommand as a fallback) and
// only counts the leak + shows the toast when insertion actually succeeded.
// If both insertion paths fail we must NOT claim a mask happened — that would
// mislead the user about a privacy-critical action — so we log an error and
// leave the counter and UI untouched. The default paste was already prevented,
// so no original (unmasked) text reached the editor either.
export function maskInsertAndNotify(
  adapter: SiteAdapter,
  target: Element,
  maskedText: string,
  findings: Finding[],
  toastOptions: ToastOptions,
): MaskInsertResult {
  const inserted =
    adapter.insertText(target, maskedText) || document.execCommand('insertText', false, maskedText)

  if (!inserted) {
    console.error(
      '[AI Leak Guard] Could not insert masked text (site adapter and execCommand both failed). Nothing was pasted; not counting or showing a toast.',
    )
    return { inserted: false, handle: null }
  }

  void incrementCounters(findings)
  const handle = showToast(toastOptions)
  return { inserted: true, handle }
}
