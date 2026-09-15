// V1.3.3 Live Gate C — the per-route status store.
//
// Each live route (surface × state) carries its OWN status: when it was last
// attempted, its last result, when it last PASSED, and its current
// consecutive-pass streak. A run for one route never refreshes another's — a
// green ChatGPT run cannot make a stale/blocked Claude route read green.
//
// Only a fresh PASS counts as live-pass evidence. A route whose last PASS is
// older than 36 h reads STALE (never green); UNCLASSIFIED, blocked (ENV/AUTH),
// GAP, and skipped results never count. This is what makes "absence /
// blocked / never-ran must never read green" true at the per-route level,
// alongside the workflow's dead-man's switch.
//
// Pure data logic (the fs load/save helpers at the bottom are the only I/O),
// so the store + expiry are unit-tested without a browser.

/** All outcomes a route can record. */
export type RouteResult = 'PASS' | 'PRODUCT_FAILURE' | 'ENV_AUTH_FAILURE' | 'UNCLASSIFIED' | 'GAP'

export interface RouteStatusEntry {
  /** ISO-8601 of the most recent attempt (any result). */
  readonly lastAttemptAt: string
  /** The most recent result. */
  readonly lastResult: RouteResult
  /** ISO-8601 of the most recent PASS, or null if never. */
  readonly lastSuccessAt: string | null
  /** Consecutive PASSes ending at the latest attempt (0 once a non-PASS lands). */
  readonly consecutivePasses: number
}

export type RouteStatusMap = Record<string, RouteStatusEntry>

/** A route with no fresh PASS within this window reads stale (never green). */
export const STALE_AFTER_MS = 36 * 60 * 60 * 1000

/** Consecutive scheduled PASSes required before a required route is release-ready. */
export const DEFAULT_MIN_CONSECUTIVE = 2

/** Record one route's result, updating success timestamp + streak. Pure. */
export function recordResult(
  map: RouteStatusMap,
  routeKey: string,
  result: RouteResult,
  nowIso: string,
): RouteStatusMap {
  const prev = map[routeKey]
  const passed = result === 'PASS'
  return {
    ...map,
    [routeKey]: {
      lastAttemptAt: nowIso,
      lastResult: result,
      lastSuccessAt: passed ? nowIso : (prev?.lastSuccessAt ?? null),
      consecutivePasses: passed ? (prev?.consecutivePasses ?? 0) + 1 : 0,
    },
  }
}

/** True when a route has no PASS within `maxAgeMs` (missing counts as stale). */
export function isStale(
  entry: RouteStatusEntry | undefined,
  nowMs: number,
  maxAgeMs: number = STALE_AFTER_MS,
): boolean {
  if (entry === undefined || entry.lastSuccessAt === null) return true
  return nowMs - Date.parse(entry.lastSuccessAt) > maxAgeMs
}

/**
 * A route is GREEN only when its LAST result was PASS and that success is
 * within the freshness window. Any non-PASS last result (UNCLASSIFIED,
 * ENV_AUTH_FAILURE, PRODUCT_FAILURE, GAP), a missing entry, or a stale success
 * is NOT green.
 */
export function isGreen(
  entry: RouteStatusEntry | undefined,
  nowMs: number,
  maxAgeMs: number = STALE_AFTER_MS,
): boolean {
  if (entry === undefined) return false
  if (entry.lastResult !== 'PASS') return false
  return !isStale(entry, nowMs, maxAgeMs)
}

export interface ReadinessRow {
  readonly routeKey: string
  readonly green: boolean
  readonly stale: boolean
  readonly lastResult: RouteResult | 'MISSING'
  readonly lastSuccessAt: string | null
  readonly consecutivePasses: number
  readonly reason: string
}

export interface ReadinessReport {
  readonly ok: boolean
  readonly rows: readonly ReadinessRow[]
}

/**
 * Evaluate release readiness for the REQUIRED routes: each must be green (last
 * result PASS, within 36 h) AND have at least `minConsecutive` consecutive
 * passes. Non-required routes (e.g. known GAPs) are not evaluated here.
 */
export function evaluateReadiness(
  map: RouteStatusMap,
  requiredRoutes: readonly string[],
  nowMs: number,
  opts: { minConsecutive?: number; maxAgeMs?: number } = {},
): ReadinessReport {
  const minConsecutive = opts.minConsecutive ?? DEFAULT_MIN_CONSECUTIVE
  const maxAgeMs = opts.maxAgeMs ?? STALE_AFTER_MS
  const rows = requiredRoutes.map((routeKey): ReadinessRow => {
    const entry = map[routeKey]
    const stale = isStale(entry, nowMs, maxAgeMs)
    const green = isGreen(entry, nowMs, maxAgeMs)
    const enoughStreak = (entry?.consecutivePasses ?? 0) >= minConsecutive
    const ready = green && enoughStreak
    let reason: string
    if (entry === undefined) reason = 'no run recorded'
    else if (entry.lastResult !== 'PASS') reason = `last result ${entry.lastResult} (not PASS)`
    else if (stale) reason = `last PASS is stale (> ${Math.round(maxAgeMs / 3_600_000)}h old)`
    else if (!enoughStreak)
      reason = `only ${entry.consecutivePasses}/${minConsecutive} consecutive passes`
    else reason = 'ready'
    return {
      routeKey,
      green: ready,
      stale,
      lastResult: entry?.lastResult ?? 'MISSING',
      lastSuccessAt: entry?.lastSuccessAt ?? null,
      consecutivePasses: entry?.consecutivePasses ?? 0,
      reason,
    }
  })
  return { ok: rows.every((r) => r.green), rows }
}
