import type { Finding } from '../detector/types'
import type { MaskedSegment } from './masker'
import type { SiteAdapter } from './adapters/base'
import { decrementCounters } from '../shared/counter'

function readCurrentText(target: Element): string {
  if (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT') {
    return (target as HTMLTextAreaElement | HTMLInputElement).value
  }
  return target.textContent ?? ''
}

// Restores the original values by replacing ONLY the placeholder spans within
// the current field content — anything the user typed after the paste is left
// untouched. Placeholders are replaced left-to-right so repeated placeholders
// map to their respective originals. If a placeholder can no longer be found
// (the user edited it), we refuse to restore and return false so the caller can
// surface an error rather than destroy content. Returns false (without
// decrementing) when restoration can't be applied or the editor rejects it.
export function undoMask(
  adapter: SiteAdapter,
  target: Element,
  segments: MaskedSegment[],
  findings: Finding[],
): boolean {
  const current = readCurrentText(target)

  let restored = current
  let searchFrom = 0
  for (const segment of segments) {
    const index = restored.indexOf(segment.placeholder, searchFrom)
    if (index === -1) {
      console.warn(
        '[AI Leak Guard] Undo skipped: a placeholder is no longer present (the input was edited); not restoring to avoid clobbering content.',
      )
      return false
    }
    restored =
      restored.slice(0, index) +
      segment.original +
      restored.slice(index + segment.placeholder.length)
    searchFrom = index + segment.original.length
  }

  const ok = adapter.replaceContents(target, restored)
  if (!ok) {
    console.warn(
      '[AI Leak Guard] Undo failed: replaceContents returned false; the field was not restored and the counter is left unchanged.',
    )
    return false
  }

  void decrementCounters(findings)
  return true
}
