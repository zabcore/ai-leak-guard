import type { Finding } from '../detector/types'
import type { MaskedSegment } from './masker'
import type { SiteAdapter } from './adapters/base'
import { decrementCounters } from '../shared/counter'

export type UndoOutcome = 'restored' | 'partial' | 'failed'

function readCurrentText(target: Element): string {
  if (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT') {
    return (target as HTMLTextAreaElement | HTMLInputElement).value
  }
  return target.textContent ?? ''
}

// Restores original values by replacing ONLY the placeholder spans within the
// current field content — text typed after the paste is left untouched. Each
// placeholder's leftmost remaining occurrence is replaced, so repeated
// placeholders map to their respective originals in order and replacements
// never break when offsets shift (an earlier approach that searched forward
// from the previous match could overshoot a nearby placeholder when the
// original was longer than the placeholder, failing multi-finding undos).
//
// Returns 'restored' when every placeholder was found and replaced, 'partial'
// when some were missing (user edited them) but at least one was restored, and
// 'failed' when none could be restored or the editor rejected the change.
// Counters are only decremented on a full restore.
export function undoMask(
  adapter: SiteAdapter,
  target: Element,
  segments: MaskedSegment[],
  findings: Finding[],
): UndoOutcome {
  const current = readCurrentText(target)

  let restored = current
  let restoredCount = 0
  let missingCount = 0
  for (const segment of segments) {
    const index = restored.indexOf(segment.placeholder)
    if (index === -1) {
      missingCount += 1
      continue
    }
    restored =
      restored.slice(0, index) +
      segment.original +
      restored.slice(index + segment.placeholder.length)
    restoredCount += 1
  }

  if (restoredCount === 0) {
    console.warn(
      '[AI Leak Guard] Undo skipped: no placeholders were found (the input was edited); nothing restored.',
    )
    return 'failed'
  }

  const ok = adapter.replaceContents(target, restored)
  if (!ok) {
    console.warn(
      '[AI Leak Guard] Undo failed: replaceContents returned false; the field was not restored and the counter is left unchanged.',
    )
    return 'failed'
  }

  if (missingCount === 0) {
    void decrementCounters(findings)
    return 'restored'
  }

  console.warn(
    `[AI Leak Guard] Undo partially applied: ${missingCount} placeholder(s) were edited and could not be restored.`,
  )
  return 'partial'
}
