// Pure logic for the V1.1 preview-before-send paste flow. No DOM, no Chrome
// APIs — everything in this module is a plain function driven by the engine's
// public helpers (`detectDetailed`, `isMaskable`, `mask`). Kept separate from
// `preview-modal.ts` (which is DOM-heavy) so the decision + summary logic can
// be exercised by unit tests without jsdom.

import type { Finding } from '../detector/types'
import { detectDetailed, isMaskable } from '../detector/engine'
import { mask } from './masker'

export type PasteDecision =
  | { readonly action: 'passthrough' }
  | {
      readonly action: 'intercept'
      readonly findings: readonly Finding[]
      readonly maskable: readonly Finding[]
    }

/**
 * Decides whether a paste of `text` should proceed natively (no modal) or be
 * intercepted and previewed. The one and only source of truth for that
 * decision is the engine's `detectDetailed(text).hasCriticalOrHigh` flag —
 * the modal never re-derives sensitivity on its own. When `hasCriticalOrHigh`
 * is true the engine is telling us there is at least one CRITICAL/HIGH
 * finding; the caller shows the modal against the `maskable` subset
 * (`findings.filter(isMaskable)`), which is the same set the masker will
 * actually replace on `Paste protected version`.
 */
export function decidePasteAction(text: string): PasteDecision {
  const { findings, hasCriticalOrHigh } = detectDetailed(text)
  if (!hasCriticalOrHigh) return { action: 'passthrough' }
  const maskable = findings.filter(isMaskable)
  return { action: 'intercept', findings, maskable }
}

export interface PreviewSummaryGroup {
  readonly label: string
  readonly count: number
}

export interface PreviewSummary {
  /** Total number of maskable findings (sum of `groups[].count`). */
  readonly count: number
  /**
   * One entry per distinct human-readable label, in first-seen order, with the
   * number of maskable findings carrying that label. Rendered in the modal as
   * `1 patient name · 1 MRN · 1 date of birth`.
   */
  readonly groups: readonly PreviewSummaryGroup[]
  /**
   * The exact string that will be inserted if the user clicks
   * `Paste protected version`. Equals `mask(text, maskable).text` where
   * `maskable = findings.filter(isMaskable)`.
   */
  readonly protectedText: string
}

/**
 * Builds the modal's user-facing summary from the same findings the engine
 * produced. Filters through `isMaskable` — the SAME predicate the paste flow
 * uses to decide what actually gets masked — so the "will be masked" list in
 * the UI cannot drift from the redacted preview or from the inserted text.
 * LOW / clinical-context findings are excluded here because `isMaskable`
 * excludes them; the modal is never given a chance to surface them.
 */
export function buildPreviewSummary(text: string, findings: readonly Finding[]): PreviewSummary {
  const maskable = findings.filter(isMaskable)
  const counts = new Map<string, number>()
  for (const finding of maskable) {
    counts.set(finding.label, (counts.get(finding.label) ?? 0) + 1)
  }
  const groups: PreviewSummaryGroup[] = Array.from(counts.entries()).map(([label, count]) => ({
    label,
    count,
  }))
  const { text: protectedText } = mask(text, maskable)
  return { count: maskable.length, groups, protectedText }
}
