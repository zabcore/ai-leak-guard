// V1.3.1 §Growth Loop — persistence for the `growthPrompt` state.
//
// METADATA ONLY. Reads and writes go through a strict projection so only the
// nine allowed timestamp/count/boolean fields ever touch storage — no page
// content, prompt text, filenames, or matched values can be persisted here
// even if a caller tried. DOM-free and network-free, so it is safe to import
// from the content-script report flow (for `recordProblemReport`) as well as
// the popup / activity page.
//
// Follows the same posture as `src/shared/storage.ts`: talk to
// `chrome.storage.local` directly (the test shim provides an in-memory
// stand-in), and never throw — a storage failure degrades to defaults so the
// growth loop can never break the popup or the protection flow.

import { applyProblemReport } from './eligibility'
import type { GrowthState } from './types'

export const GROWTH_KEY = 'growthPrompt'

/** Default state for a brand-new install (installDate unset → 0). */
export function defaultGrowthState(): GrowthState {
  return {
    installDate: 0,
    firstEligibleAt: null,
    lastShownAt: null,
    dismissCount: 0,
    dismissedUntil: null,
    reviewClicked: false,
    shareClicked: false,
    permanentlySuppressed: false,
    lastProblemReportAt: null,
  }
}

function num(x: unknown): number {
  return typeof x === 'number' && Number.isFinite(x) ? x : 0
}

function nullableTs(x: unknown): number | null {
  return typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : null
}

function bool(x: unknown): boolean {
  return x === true
}

/**
 * Project an untrusted stored value onto the exact `GrowthState` shape. Any
 * stray field (a hostile edit at chrome://extensions, or an older build) falls
 * away — this is the single metadata-only choke point for the growth key.
 */
export function projectGrowthState(raw: unknown): GrowthState {
  const r = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    installDate: Math.max(0, num(r.installDate)),
    firstEligibleAt: nullableTs(r.firstEligibleAt),
    lastShownAt: nullableTs(r.lastShownAt),
    dismissCount: Math.max(0, Math.floor(num(r.dismissCount))),
    dismissedUntil: nullableTs(r.dismissedUntil),
    reviewClicked: bool(r.reviewClicked),
    shareClicked: bool(r.shareClicked),
    permanentlySuppressed: bool(r.permanentlySuppressed),
    lastProblemReportAt: nullableTs(r.lastProblemReportAt),
  }
}

/** Read the growth state; never throws (a broken read degrades to defaults). */
export async function readGrowthState(): Promise<GrowthState> {
  try {
    const stored = await chrome.storage.local.get(GROWTH_KEY)
    return projectGrowthState(stored[GROWTH_KEY])
  } catch (err) {
    console.warn('[AI Leak Guard] growth state read failed:', err)
    return defaultGrowthState()
  }
}

/** Write the growth state (projected). Best-effort — never throws. */
export async function writeGrowthState(state: GrowthState): Promise<void> {
  try {
    await chrome.storage.local.set({ [GROWTH_KEY]: projectGrowthState(state) })
  } catch (err) {
    console.warn('[AI Leak Guard] growth state write failed:', err)
  }
}

/**
 * Record that the user proceeded through the §E problem report, so the growth
 * prompt is suppressed for a window afterwards. Best-effort and never throws —
 * this is called from the report flow (popup AND content script) and must
 * never interfere with it.
 */
export async function recordProblemReport(now: number = Date.now()): Promise<void> {
  try {
    const state = await readGrowthState()
    await writeGrowthState(applyProblemReport(state, now))
  } catch (err) {
    console.warn('[AI Leak Guard] growth: recordProblemReport failed:', err)
  }
}
