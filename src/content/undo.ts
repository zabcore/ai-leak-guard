import type { Finding } from '../detector/types'
import type { SiteAdapter } from './adapters/base'
import { decrementCounters } from '../shared/counter'

function readCurrentText(target: Element): string {
  if (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT') {
    return (target as HTMLTextAreaElement | HTMLInputElement).value
  }
  return target.textContent ?? ''
}

// Restores the original pasted text. To avoid blowing away anything the user
// typed after the paste, it replaces only the masked span within the current
// content when that span is still present; otherwise it restores the original
// text directly. Returns true only if the editor accepted the change — the
// caller surfaces an error and leaves the counter alone when it returns false.
export function undoMask(
  adapter: SiteAdapter,
  target: Element,
  originalText: string,
  maskedText: string,
  findings: Finding[],
): boolean {
  const current = readCurrentText(target)
  const restoredText = current.includes(maskedText)
    ? current.replace(maskedText, originalText)
    : originalText

  const restored = adapter.replaceContents(target, restoredText)
  if (!restored) {
    console.warn(
      '[AI Leak Guard] Undo failed: replaceContents returned false; the field was not restored and the counter is left unchanged.',
    )
    return false
  }

  void decrementCounters(findings)
  return true
}
