import type { Finding } from '../detector/types'
import type { MaskedSegment } from './masker'
import type { SiteAdapter } from './adapters/base'
import { decrementCounters } from '../shared/counter'

export type UndoOutcome = 'restored' | 'partial' | 'failed'

/**
 * Optional whole-paste context that lets undo do a robust field-wide
 * restore in the common case (user hits Undo immediately, has not
 * edited). Without this, ProseMirror editors (ChatGPT / Claude) can
 * transform the placeholders we inserted — e.g. wrap them in schema
 * nodes, split them across text nodes, or reflow whitespace — so a
 * plain `textContent.indexOf(placeholder)` search returns -1 and the
 * whole undo fails with "Couldn't undo automatically."
 *
 * When both fields are present and the current field text matches
 * `maskedText` byte-for-byte, we skip the per-placeholder search and
 * replace the whole field with `originalText`. When the user has edited
 * after paste, we fall through to the per-placeholder algorithm below,
 * which is precise but can miss on ProseMirror-transformed placeholders.
 */
export interface UndoContext {
  maskedText: string
  originalText: string
}

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
//
// When `ctx` (maskedText + originalText) is supplied AND the current field
// text equals maskedText exactly (untouched-since-paste), we short-circuit
// with a whole-field replaceContents to the originalText. This is what makes
// undo work on ProseMirror-based editors, which can transform the pasted
// placeholders in ways that defeat the per-placeholder search.
export function undoMask(
  adapter: SiteAdapter,
  target: Element,
  segments: MaskedSegment[],
  findings: Finding[],
  ctx?: UndoContext,
): UndoOutcome {
  const current = readCurrentText(target)

  if (ctx !== undefined && current === ctx.maskedText) {
    const ok = adapter.replaceContents(target, ctx.originalText)
    if (!ok) {
      console.warn(
        '[AI Leak Guard] Undo failed: replaceContents returned false during whole-field restore; the counter is left unchanged.',
      )
      return 'failed'
    }
    void decrementCounters(findings)
    return 'restored'
  }

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
      '[AI Leak Guard] Undo skipped: no placeholders were found (the input was edited or the editor transformed them); nothing restored.',
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
