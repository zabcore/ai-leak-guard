// V1.2 A5.1 shared UI labels for the popup + activity page.
//
// Kept in one place so a change to the friendly copy is a single
// edit — the popup's compact recent-activity list, the activity
// page's full table, and any future paid-tier dashboard all
// re-use these mappings. Everything here is derived from the
// AlgEvent schema alone (site id, action, category); nothing here
// reads content or a filename, and every fallback returns the raw
// enum string so an unlisted future value degrades gracefully
// instead of blank-rendering.

import { DetectorCategory } from '../detector/types'
import type { AlgEvent } from '../shared/event-log'

/**
 * Friendly site labels for tiles / rows / chips. Same list the
 * V1.2 A4 warning modal uses so the popup and the modal don't
 * disagree about what "chatgpt" or "claude" is called.
 */
export const SITE_LABELS: Readonly<Record<string, string>> = {
  chatgpt: 'ChatGPT',
  claude: 'Claude',
  gemini: 'Gemini',
  perplexity: 'Perplexity',
  copilot: 'Copilot',
}

export function siteLabel(id: string): string {
  return SITE_LABELS[id] ?? id
}

/** Friendly verbs for each AlgEvent action. */
export const ACTION_LABELS: Readonly<Record<AlgEvent['action'], string>> = {
  protected: 'protected',
  'as-is': 'pasted as-is',
  cancelled: 'cancelled',
  'uploaded-anyway': 'uploaded anyway',
  'auto-cleared': 'auto-cleared',
  'unable-to-inspect': "couldn't inspect",
}

export function actionLabel(action: AlgEvent['action']): string {
  return ACTION_LABELS[action] ?? action
}

/**
 * Friendly category labels — mirrors the A4 document-modal chip
 * copy so the popup + activity page render the same phrasing the
 * user just saw when they made the decision.
 */
export const CATEGORY_LABELS: Readonly<Record<DetectorCategory, string>> = {
  [DetectorCategory.HEALTHCARE_PATIENT_ID]: 'Patient identifiers (MRN)',
  [DetectorCategory.IDENTITY]: 'Personal identity',
  [DetectorCategory.GOVERNMENT_FINANCIAL]: 'SSN / financial',
  [DetectorCategory.PROVIDER_ID]: 'Provider ID (NPI)',
  [DetectorCategory.DEVELOPER_CREDENTIAL]: 'Credentials',
  [DetectorCategory.CLINICAL_CONTEXT]: 'Clinical context',
}

export function categoryLabel(cat: DetectorCategory): string {
  return CATEGORY_LABELS[cat] ?? cat
}

/**
 * Compact relative time — "just now" / "5m ago" / "3h ago" /
 * "2d ago". Metadata only (the timestamp itself is `Date.now()`
 * from the content-script side).
 *
 * Threshold is 60s (not 45s) so "0m ago" never shows up in the
 * 45–59s range.
 */
export function relativeTime(ts: number, now: number = Date.now()): string {
  const diffMs = Math.max(0, now - ts)
  const sec = Math.floor(diffMs / 1000)
  if (sec < 60) return 'just now'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  return `${day}d ago`
}
