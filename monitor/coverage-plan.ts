// V1.3.1 §C — Gate C compatibility monitor: the probe plan.
//
// This module is the ONLY place the monitor decides WHAT to check, and
// it derives every decision from the §D coverage definition
// (`src/shared/coverage.ts`) — the single source of truth. It contains
// NO Playwright / browser code so it stays pure and unit-testable (a
// vitest suite pins it), and so `coverage.ts` and the monitor can never
// silently drift: add a surface or flip a flag in coverage and the plan
// (and therefore the browser probes) follows automatically.
//
// Derivation is deliberately two-sided, straight off the coverage entry:
//   • POSITIVE probes ("the extension MUST intervene") come from
//     `inputRoutes` — coverage lists a route only when its flag is
//     'supported' (asserted by the coverage suite), so each listed route
//     is a promise we verify the shipped extension keeps.
//   • NEGATIVE probes ("the extension MUST NOT intervene") come from the
//     'unsupported' flags — these are the honesty checks. If a future
//     change accidentally started intercepting Copilot file uploads, or
//     Perplexity sends, the negative probe fails and coverage/code are
//     shown to disagree.
//   • 'unvalidated' flags are recorded but never asserted either way —
//     they are, by definition, unproven (they need a live licensed
//     probe, §4).

import { COVERAGE, type SurfaceCoverage } from '../src/shared/coverage'

/** A concrete gesture the monitor can drive against a surface fixture. */
export type ProbeRoute = 'paste' | 'send-enter' | 'send-button' | 'document'

/** Whether the extension must step in on this route, or stay out of the way. */
export type Expectation = 'intervene' | 'passthrough'

export interface RouteProbe {
  readonly route: ProbeRoute
  readonly expect: Expectation
  /** Human-readable reason, surfaced in test titles / failure messages. */
  readonly because: string
}

export interface SurfacePlan {
  readonly id: string
  readonly label: string
  readonly origins: readonly string[]
  /** Routes with a definite expectation (positive or negative). */
  readonly probes: readonly RouteProbe[]
  /** Routes coverage marks 'unvalidated' — recorded, never asserted. */
  readonly unvalidated: readonly ProbeRoute[]
  /**
   * False when another surface's origins are a strict superset of this
   * one's, i.e. the extension cannot tell them apart by origin (Microsoft
   * 365 Copilot shares `copilot.cloud.microsoft` with personal Copilot).
   * Such a surface cannot be rendered in isolation, so it is documented,
   * not browser-probed.
   */
  readonly independentlyProbeable: boolean
}

/** Map a coverage `inputRoute` to the monitor gesture that exercises it. */
function routeForInput(inputRoute: string): ProbeRoute | null {
  switch (inputRoute) {
    case 'paste-text':
      return 'paste'
    case 'send-enter':
      return 'send-enter'
    case 'send-button':
      return 'send-button'
    case 'file-change':
    case 'file-drop':
    case 'file-paste':
    case 'file-picker':
      return 'document'
    default:
      return null
  }
}

/**
 * A surface is NOT independently probeable when a DIFFERENT surface's
 * origin set is a strict superset of its own — the extension matches on
 * origin, so it cannot render or attribute this surface separately.
 */
function isIndependentlyProbeable(
  surface: SurfaceCoverage,
  all: readonly SurfaceCoverage[],
): boolean {
  const mine = new Set(surface.origins)
  return !all.some((other) => {
    if (other.id === surface.id) return false
    const theirs = new Set(other.origins)
    if (theirs.size <= mine.size) return false
    for (const o of mine) if (!theirs.has(o)) return false
    return true // theirs ⊋ mine
  })
}

function planForSurface(surface: SurfaceCoverage, all: readonly SurfaceCoverage[]): SurfacePlan {
  const probes: RouteProbe[] = []
  const seen = new Set<ProbeRoute>()
  const add = (route: ProbeRoute, expect: Expectation, because: string): void => {
    // One probe per route; the positive pass (from inputRoutes) is added
    // first and wins, but by construction positive and negative never
    // collide (a route is either in inputRoutes or its flag is unsupported).
    if (seen.has(route)) return
    seen.add(route)
    probes.push({ route, expect, because })
  }

  // POSITIVE — every listed input route is a 'supported' promise.
  for (const input of surface.inputRoutes) {
    const route = routeForInput(input)
    if (route === null) continue
    add(route, 'intervene', `coverage lists inputRoute "${input}" (a supported claim)`)
  }

  // NEGATIVE — 'unsupported' flags must hold true in the shipped code.
  const unvalidated: ProbeRoute[] = []
  if (surface.paste === 'unsupported') add('paste', 'passthrough', "paste flag is 'unsupported'")
  if (surface.paste === 'unvalidated') unvalidated.push('paste')
  if (surface.send === 'unsupported') {
    // The submit adapter's contract covers BOTH Enter and the Send button,
    // so an unsupported send must be verified passthrough on both — else a
    // button-only interceptor could slip past an Enter-only negative.
    add('send-enter', 'passthrough', "send flag is 'unsupported'")
    add('send-button', 'passthrough', "send flag is 'unsupported'")
  }
  if (surface.send === 'unvalidated') unvalidated.push('send-enter')
  if (surface.document === 'unsupported')
    add('document', 'passthrough', "document flag is 'unsupported'")

  return {
    id: surface.id,
    label: surface.label,
    origins: surface.origins,
    probes,
    unvalidated,
    independentlyProbeable: isIndependentlyProbeable(surface, all),
  }
}

/** The full monitor plan, derived from the §D coverage definition. */
export function buildMonitorPlan(): readonly SurfacePlan[] {
  return COVERAGE.surfaces.map((s) => planForSurface(s, COVERAGE.surfaces))
}

/** Surfaces that can be rendered in isolation and carry at least one probe. */
export function browserProbeSurfaces(): readonly SurfacePlan[] {
  return buildMonitorPlan().filter((p) => p.independentlyProbeable && p.probes.length > 0)
}
