// V1.3 M1 risk fingerprint for send-time dedup.
//
// A fingerprint is the *shape* of a detection result — category →
// maskable-finding count — never its content. It exists so that a
// user who has already looked at "2 × SSN, 1 × MRN" and chosen
// "send anyway" is not shown the same warning again for the same
// composer when they hit Enter a second time (e.g. after the site
// swallowed the first resume, or after an edit that did not change
// the risk picture).
//
// INTENTIONAL TRADE-OFF — keyed on risk shape, not identity. Two
// *different* SSNs produce the same fingerprint ("government_financial:1"),
// so replacing one SSN with another after acknowledging does NOT
// re-warn. The alternative — hashing matched values — would put a
// derivative of the sensitive content in memory keyed to the tab,
// which the metadata-only posture forbids. Shape-keying is the
// conservative choice: it can only ever under-warn on an edit that
// keeps the exact same category/count profile, and any change in
// category or count re-warns.
//
// Fingerprints live in memory only, scoped to (tab, composer), and
// are NEVER written to `chrome.storage` — a release blocker, pinned
// by `tests/submit-core.test.ts`.

import { isMaskable } from '../../detector/engine'
import type { Finding } from '../../detector/types'

/** Stable, content-free string: `category:count|category:count`, sorted by category. `'none'` when nothing is maskable. */
export type RiskFingerprint = string

export const EMPTY_FINGERPRINT: RiskFingerprint = 'none'

export function fingerprintFindings(findings: readonly Finding[]): RiskFingerprint {
  const counts = new Map<string, number>()
  for (const f of findings) {
    if (!isMaskable(f)) continue
    const category = f.category ?? 'uncategorized'
    counts.set(category, (counts.get(category) ?? 0) + 1)
  }
  if (counts.size === 0) return EMPTY_FINGERPRINT
  return [...counts.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([category, n]) => `${category}:${n}`)
    .join('|')
}
