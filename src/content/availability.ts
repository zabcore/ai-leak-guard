// V1.3.3 — availability computation for the compact in-page indicator.
//
// AVAILABILITY, NOT A GUARANTEE. This computes whether the extension is present
// and ready to act on the current surface — never a "you are protected" claim.
// Two hard rules the acceptance pins:
//   • `activeHere` is derived from COVERAGE (`src/shared/coverage.ts`) + LIVE
//     adapter readiness (a composer resolvable RIGHT NOW) + the master toggle —
//     NEVER from the hostname alone, and NEVER from a prior self-test pass. So a
//     stale self-test can't make it read ready when the composer is gone.
//   • The signals stay SEPARATE (composer / paste / send / file scanning / last
//     self-test) — there is no single composite "protected" state.
//
// Pure (no DOM, no chrome) so it is unit-tested directly; the renderer + wiring
// supply `composerPresent`, `enabled`, and `lastSelfTest`.

import { getSurfaceCoverage, type SupportState, type SendMode } from '../shared/coverage'

/** Per-signal readiness, mirroring the coverage support states. */
export type SignalState = 'ready' | 'unsupported' | 'unvalidated'

/** The last self-test result as a SEPARATE, historical signal (never gates activeHere). */
export interface SelfTestSignalInfo {
  readonly result: 'confirmed' | 'fail' | 'unsupported'
  /** Age of the recorded result in ms. */
  readonly ageMs: number
  /** True once older than the freshness window — shown, but never "current availability". */
  readonly stale: boolean
}

export interface Availability {
  /** Coverage surface id (e.g. 'chatgpt', 'copilot-personal'). */
  readonly surfaceId: string
  /** Master toggle (the popup enable/disable pref). */
  readonly enabled: boolean
  /** LIVE: an adapter resolved a composer on this surface right now. */
  readonly composerPresent: boolean
  /**
   * The extension is present and ready to act here. AVAILABILITY, not
   * protection. Requires `enabled` AND `composerPresent` — never the hostname
   * alone, never a prior self-test. The indicator only reads "ready" when true.
   */
  readonly activeHere: boolean
  // ── separate signals (never collapsed into one "protected") ──
  readonly paste: SignalState
  readonly send: SignalState
  readonly sendMode: SendMode
  readonly fileScanning: SignalState
  readonly lastSelfTest: SelfTestSignalInfo | null
}

export interface AvailabilityInput {
  readonly surfaceId: string
  readonly enabled: boolean
  readonly composerPresent: boolean
  readonly lastSelfTest?: SelfTestSignalInfo | null
}

/** A recorded self-test older than this reads as a stale (historical) signal. */
export const SELF_TEST_FRESH_MS = 5 * 60 * 1000

function toSignal(state: SupportState): SignalState {
  if (state === 'supported') return 'ready'
  if (state === 'unvalidated') return 'unvalidated'
  return 'unsupported'
}

/**
 * Map a paste-adapter id to its coverage surface id. `copilot` resolves to the
 * validated `copilot-personal` entry (the host is shared with M365, which
 * cannot be distinguished by origin — see the §D coverage decisions).
 */
export function coverageSurfaceId(adapterId: string): string {
  return adapterId === 'copilot' ? 'copilot-personal' : adapterId
}

/** Build a `SelfTestSignalInfo` from a recorded result timestamp. */
export function selfTestSignal(
  result: SelfTestSignalInfo['result'],
  recordedAtMs: number,
  now: number,
  freshMs: number = SELF_TEST_FRESH_MS,
): SelfTestSignalInfo {
  const ageMs = Math.max(0, now - recordedAtMs)
  return { result, ageMs, stale: ageMs > freshMs }
}

export function computeAvailability(input: AvailabilityInput): Availability {
  const coverage = getSurfaceCoverage(input.surfaceId)
  return {
    surfaceId: input.surfaceId,
    enabled: input.enabled,
    composerPresent: input.composerPresent,
    // AVAILABILITY gate — enabled AND a live composer. Deliberately independent
    // of the hostname and of `lastSelfTest`.
    activeHere: input.enabled && input.composerPresent,
    paste: coverage ? toSignal(coverage.paste) : 'unsupported',
    send: coverage ? toSignal(coverage.send) : 'unsupported',
    sendMode: coverage ? coverage.sendMode : null,
    fileScanning: coverage ? toSignal(coverage.document) : 'unsupported',
    lastSelfTest: input.lastSelfTest ?? null,
  }
}
