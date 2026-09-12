// V1.3.1 §Growth Loop — gather eligibility/suppression signals from existing
// local sources. This is the IMPURE boundary (chrome.storage, chrome.tabs,
// the packaged coverage table); it does NO network and touches NO DOM, so it
// stays out of the service-worker graph and never widens the network surface.
//
// It reads ONLY things that already exist: the metadata event log, the
// self-test result, the submit kill switch, and the packaged coverage
// definition. It writes nothing and adds no permission — reading the active
// tab's URL uses the host permissions the extension already declares.

import { COVERAGE, type SurfaceCoverage } from '../shared/coverage'
import { getEvents } from '../shared/event-log'
import { getSelfTestResult, getSubmitKillSwitch } from '../shared/storage'
import { countProtectionEvents } from './eligibility'
import type { CountableEvent, EligibilityInputs, GrowthState } from './types'

/** Match a URL against a coverage surface's origin globs (`https://host/*`). */
function surfaceMatchesUrl(surface: SurfaceCoverage, url: string): boolean {
  return surface.origins.some((origin) => {
    const prefix = origin.endsWith('*') ? origin.slice(0, -1) : origin
    return url.startsWith(prefix)
  })
}

/** A surface is "supported" when it makes at least one supported claim. */
function surfaceHasSupportedChannel(surface: SurfaceCoverage): boolean {
  return (
    surface.paste === 'supported' ||
    surface.send === 'supported' ||
    surface.document === 'supported'
  )
}

/**
 * True when a URL is NOT on a surface with any supported channel — either it
 * matches no in-scope surface at all (a random site, an extension page) or the
 * matched surface has no supported channel. Exported for tests.
 */
export function isUnsupportedSiteUrl(url: string | undefined | null): boolean {
  if (typeof url !== 'string' || url.length === 0) return true
  const surface = COVERAGE.surfaces.find((s) => surfaceMatchesUrl(s, url))
  if (surface === undefined) return true
  return !surfaceHasSupportedChannel(surface)
}

/** Read the active tab's URL (best-effort). '' when unavailable. */
async function activeTabUrl(): Promise<string> {
  try {
    const tabsApi = (globalThis as unknown as { chrome?: typeof chrome }).chrome?.tabs
    if (tabsApi && typeof tabsApi.query === 'function') {
      const active = await tabsApi.query({ active: true, currentWindow: true })
      return active[0]?.url ?? ''
    }
  } catch {
    // No tabs access → treat as unknown (unsupported).
  }
  return ''
}

export interface GatherOptions {
  readonly now?: number
  /**
   * Whether to evaluate the active-tab "current site unsupported" suppression.
   * The popup passes `true` (it rides the active browsing tab); the activity
   * page passes `false` (a deliberate destination, not a live surface).
   */
  readonly checkActiveSite: boolean
}

/**
 * Resolve every input `computeEligibility` needs from local sources. Each read
 * is independently best-effort so one broken source degrades to its safe
 * default rather than throwing.
 */
export async function gatherEligibilityInputs(
  state: GrowthState,
  opts: GatherOptions,
): Promise<EligibilityInputs> {
  const now = opts.now ?? Date.now()

  const [events, selfTestRec, killSwitch, siteUnsupported] = await Promise.all([
    safeGetEvents(),
    safeSelfTest(),
    safeKillSwitch(),
    opts.checkActiveSite ? activeTabUrl().then(isUnsupportedSiteUrl) : Promise.resolve(false),
  ])

  const countable: CountableEvent[] = events.map((e) => ({
    ts: e.ts,
    site: e.site,
    action: e.action,
    categories: e.categories,
    count: e.count,
    hadCriticalOrHigh: e.hadCriticalOrHigh,
  }))
  const last = countable.length > 0 ? countable[countable.length - 1] : null

  return {
    now,
    state,
    protectionEventCount: countProtectionEvents(countable),
    selfTest: selfTestRec,
    killSwitch,
    currentSiteUnsupported: siteUnsupported,
    mostRecentEvent: last === null ? null : { action: last.action, ts: last.ts },
  }
}

async function safeGetEvents(): Promise<Awaited<ReturnType<typeof getEvents>>> {
  try {
    return await getEvents()
  } catch {
    return []
  }
}

async function safeSelfTest(): Promise<{ result: string; tsMs: number } | null> {
  try {
    const rec = await getSelfTestResult()
    if (rec === null) return null
    const tsMs = Date.parse(rec.ts)
    if (!Number.isFinite(tsMs)) return null
    return { result: rec.result, tsMs }
  } catch {
    return null
  }
}

async function safeKillSwitch(): Promise<{ ts: number } | null> {
  try {
    const ks = await getSubmitKillSwitch()
    return ks === null ? null : { ts: ks.ts }
  } catch {
    return null
  }
}
