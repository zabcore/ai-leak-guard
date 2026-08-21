// V1.2 A5 (#40) event-log schema + projection.
//
// Split out from `event-log.ts` so BOTH the content-script side
// (which sends the append request) AND the service-worker side
// (which serialises the write) can validate + project against the
// exact same shape. Keeping the schema in one place also makes
// the "no content ever lands in storage" invariant reviewable at
// a single site.
//
// The moat rule (non-negotiable, test-asserted): every persisted
// record has EXACTLY the seven allowed fields — no `value`,
// `text`, `filename`, `body`, or anything else a caller (hostile
// or accidental) might staple on. `projectAlgEvent` is the choke
// point — the service worker calls it on every incoming append
// request AND on every existing record read from storage, so a
// polluted historical entry (edited by hand at chrome://extensions,
// or written by a pre-projection build of the extension) can
// never survive a subsequent write.

import type { DetectorCategory } from '../detector/types'
import { DetectorCategory as DetectorCategoryValues } from '../detector/types'

export type AlgEventType = 'paste' | 'document'

export type AlgAction =
  | 'protected'
  | 'as-is'
  | 'cancelled'
  | 'uploaded-anyway'
  | 'auto-cleared'
  | 'unable-to-inspect'

export interface AlgEvent {
  readonly ts: number
  readonly site: string
  readonly eventType: AlgEventType
  readonly action: AlgAction
  readonly categories: readonly DetectorCategory[]
  readonly count: number
  readonly hadCriticalOrHigh: boolean
}

/**
 * Ring-buffer cap. 200 is plenty for a "recent activity" popup
 * (weeks of typical use) and small enough that even the fattest
 * `AlgEvent` (~200 bytes) stays well under any
 * `chrome.storage.local` per-key quota.
 */
export const MAX_EVENTS = 200

// Closed-set enumerations — a value outside these sets is
// rejected at projection time, not silently persisted.
const ALLOWED_ACTIONS: ReadonlySet<AlgAction> = new Set<AlgAction>([
  'protected',
  'as-is',
  'cancelled',
  'uploaded-anyway',
  'auto-cleared',
  'unable-to-inspect',
])
const ALLOWED_CATEGORIES: ReadonlySet<string> = new Set<string>(
  Object.values(DetectorCategoryValues),
)

/**
 * Structural predicate — the SHAPE required for a persisted
 * record. Used by `getEvents` in the popup + by the service
 * worker to reject anything that doesn't look like an `AlgEvent`.
 * Doesn't enforce field allowlist (that's `projectAlgEvent`'s
 * job); this predicate is purely "does it have the right keys of
 * the right types".
 */
export function isProjectedAlgEvent(x: unknown): x is AlgEvent {
  if (x === null || typeof x !== 'object') return false
  const r = x as Record<string, unknown>
  if (typeof r.ts !== 'number' || !Number.isFinite(r.ts) || r.ts < 0) return false
  if (typeof r.site !== 'string') return false
  if (r.eventType !== 'paste' && r.eventType !== 'document') return false
  if (typeof r.action !== 'string' || !ALLOWED_ACTIONS.has(r.action as AlgAction)) return false
  if (!Array.isArray(r.categories)) return false
  for (const c of r.categories) {
    if (typeof c !== 'string' || !ALLOWED_CATEGORIES.has(c)) return false
  }
  if (typeof r.count !== 'number' || !Number.isFinite(r.count) || r.count < 0) return false
  if (typeof r.hadCriticalOrHigh !== 'boolean') return false
  return true
}

/**
 * Project an untrusted event-shaped input onto the seven-field
 * `AlgEvent` schema. Fails loudly on anything the predicate
 * rejects — callers must catch (the service worker swallows +
 * logs).
 *
 * The returned object is a FRESH literal with ONLY the allowed
 * fields — even if the input carried extra properties, `value`,
 * `text`, `filename`, `__proto__`, etc., they are dropped here.
 * This is the single moat-rule enforcement point.
 */
export function projectAlgEvent(x: unknown): AlgEvent {
  if (!isProjectedAlgEvent(x)) {
    throw new Error('[AI Leak Guard] event-log: input does not match AlgEvent schema')
  }
  // Explicit fresh object — any extra fields on `x` fall away.
  // `categories` is re-materialised with `.map` so a subclassed
  // Array can't carry extra own properties into storage. Element
  // validity is already guaranteed by `isProjectedAlgEvent` above
  // (every entry is required to be an allowlisted string), so the
  // `as DetectorCategory` here is a safe type assertion, not a
  // trust-me cast.
  return {
    ts: x.ts,
    site: x.site,
    eventType: x.eventType,
    action: x.action,
    categories: x.categories.map((c) => c as DetectorCategory),
    count: x.count,
    hadCriticalOrHigh: x.hadCriticalOrHigh,
  }
}
