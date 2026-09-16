// V1.3.1 §C — Gate C compatibility monitor (Playwright).
//
// Two modes (selected by MONITOR_MODE, resolved in extension.ts):
//
//   • dry (default) — loads the PACKAGED extension and, for every route the §D
//     coverage definition describes, drives the gesture on a synthetic fixture
//     at the surface's real origin and checks the shipped extension does
//     exactly what coverage promises:
//       - a 'supported' route (positive)   → the extension intervenes + warns
//       - an 'unsupported' route (negative) → the extension stays out of the way
//       - 'unvalidated' routes are neither probed nor asserted
//     Enumeration comes entirely from `buildMonitorPlan()`, so this file never
//     hard-codes a surface list.
//
//   • live-noauth — navigates the REAL logged-out surfaces (the states that
//     actually leaked) and asserts the extension still recognises the composer
//     and mounts its modal host. Any non-PASS is a red run, classified so
//     triage can tell PRODUCT drift from an ENVIRONMENT/AUTH problem.
//
// Induced-failure hook: with MONITOR_INDUCE_FAILURE=1, exactly one probe is
// forced to fail, so dispatching the workflow with induce_failure:true proves
// the alert path fires end-to-end. It is a no-op without the env var.

import {
  test,
  expect,
  openSurface,
  openLiveNoauthPage,
  openFixtureAt,
  MONITOR_MODE,
} from './extension'
import { buildMonitorPlan, type ProbeRoute } from './coverage-plan'
import {
  hasFixture,
  LIVE_NOAUTH_ROUTES,
  LEAKED_COMPOSER_FIXTURES,
  readFixtureFile,
} from './surfaces'
import {
  ensureExtensionReady,
  probePaste,
  probeSendEnter,
  probeSendButton,
  probeDocument,
  probeLiveNoauth,
  probeLeakedComposer,
  type ProbeResult,
} from './probes'
import { recordResult, type RouteResult } from './route-status'
import { loadStatus, saveStatus } from './route-status-io'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'

const STATUS_PATH = resolve(dirname(fileURLToPath(import.meta.url)), 'status', 'live-status.json')

/** Persist one route's outcome to the cross-run status store (live mode only). */
function persistRoute(routeKey: string, result: RouteResult): void {
  saveStatus(
    STATUS_PATH,
    recordResult(loadStatus(STATUS_PATH), routeKey, result, new Date().toISOString()),
  )
}

// ── induced-failure hook ────────────────────────────────────────────────────
//
// With MONITOR_INDUCE_FAILURE=1, exactly ONE probe is forced to fail so a
// dispatched run proves the alert path end-to-end. The decision is baked at
// REGISTRATION time (a single-threaded pass over the matrix), not at run time —
// runtime module state doesn't reliably persist across Playwright's per-worker
// loads, which would fail more than one probe. `nextInduce()` returns true for
// the first probe registered and false thereafter, so precisely one test
// carries the induced failure regardless of worker count.
const INDUCE_FAILURE = process.env.MONITOR_INDUCE_FAILURE === '1'
const INDUCED_MESSAGE =
  'INDUCED FAILURE (MONITOR_INDUCE_FAILURE=1): deliberately failing one probe to prove the alert path fires end-to-end. This is not a real regression.'
let induceClaimed = false
function nextInduce(): boolean {
  if (!INDUCE_FAILURE || induceClaimed) return false
  induceClaimed = true
  return true
}

if (MONITOR_MODE === 'live-noauth') {
  // ── live-noauth drift monitor ──────────────────────────────────────────────
  test.describe('§C live-noauth drift monitor', () => {
    for (const route of LIVE_NOAUTH_ROUTES) {
      const induceThis = nextInduce()
      test(`${route.routeKey} [${route.kind}]`, async ({ context }) => {
        if (induceThis) expect(false, INDUCED_MESSAGE).toBe(true)
        const { page, navError } = await openLiveNoauthPage(context, route.url)
        try {
          const { result, detail } = await probeLiveNoauth(page, route.composerSelectors, {
            navError,
          })

          if (route.kind === 'gap') {
            // A known-not-live-exercisable state (Claude pre-hydration). NEVER
            // assert PASS. A real drift (composer present but no modal) still
            // fails; "not reachable" (env/unclassified) is recorded as a GAP so
            // the JOB can stay green (heartbeat + required evidence) while the
            // route's STATUS is non-green.
            if (result === 'PRODUCT_FAILURE') {
              persistRoute(route.routeKey, 'PRODUCT_FAILURE')
              expect(
                result,
                `${route.routeKey}: pre-hydration composer present but no modal — real drift`,
              ).not.toBe('PRODUCT_FAILURE')
            } else {
              persistRoute(route.routeKey, result === 'PASS' ? 'PASS' : 'GAP')
            }
          } else {
            // Required route: must PASS live; record whatever happened.
            persistRoute(route.routeKey, result)
            expect(result, `${route.routeKey} [${result}] — ${detail}`).toBe('PASS')
          }
        } finally {
          await page.close()
        }
      })
    }
  })
} else {
  // ── dry (and future authenticated live) plan-based matrix ──────────────────
  const plan = buildMonitorPlan()

  const runProbe = (page: Page, route: ProbeRoute): Promise<ProbeResult> => {
    switch (route) {
      case 'paste':
        return probePaste(page)
      case 'send-enter':
        return probeSendEnter(page)
      case 'send-button':
        return probeSendButton(page)
      case 'document':
        return probeDocument(page)
    }
  }

  test.describe('§C coverage monitor', () => {
    for (const surface of plan) {
      test.describe(`${surface.label} (${surface.id})`, () => {
        // A surface we can't isolate by origin (M365 Copilot shares
        // copilot.cloud.microsoft with personal Copilot) is documented, not
        // browser-probed. The honesty guard: it must not claim any route
        // 'supported', because we could never distinguish that claim from
        // its host-sharing sibling.
        if (!surface.independentlyProbeable) {
          test('shares an origin with another surface → documented only, no supported claim', () => {
            for (const p of surface.probes) {
              expect(
                p.expect,
                `${surface.id} claims ${p.route} but shares a host and cannot be verified in isolation`,
              ).toBe('passthrough')
            }
            expect(surface.probes.length + surface.unvalidated.length).toBeGreaterThan(0)
          })
          return
        }

        // Any surface with probes must ship a fixture to verify them against.
        test('has a synthetic fixture backing its coverage claims', () => {
          expect(hasFixture(surface.id), `surface "${surface.id}" has probes but no fixture`).toBe(
            true,
          )
        })

        for (const probe of surface.probes) {
          const induceThis = nextInduce()
          test(`${probe.route} → ${probe.expect}  [${probe.because}]`, async ({ context }) => {
            if (induceThis) expect(false, INDUCED_MESSAGE).toBe(true)
            const page = await openSurface(context, surface)
            try {
              await ensureExtensionReady(page)
              const result = await runProbe(page, probe.route)

              if (probe.expect === 'intervene') {
                expect(
                  result.intercepted,
                  `${surface.id} ${probe.route}: extension did NOT take the gesture (adapter likely broke against this surface's DOM)`,
                ).toBe(true)
                expect(
                  result.modalAppeared,
                  `${surface.id} ${probe.route}: no warning modal appeared`,
                ).toBe(true)
              } else {
                expect(
                  result.intercepted,
                  `${surface.id} ${probe.route}: extension intercepted a route coverage marks UNSUPPORTED (coverage and code disagree)`,
                ).toBe(false)
                expect(
                  result.modalAppeared,
                  `${surface.id} ${probe.route}: a warning modal appeared on an UNSUPPORTED route`,
                ).toBe(false)
              }
            } finally {
              await page.close()
            }
          })
        }
      })
    }
  })

  // Leaked-composer regressions: reproduce the EXACT DOM that leaked (ChatGPT
  // logged-out fallback textarea, Claude pre-hydration static composer) and
  // confirm the loaded extension still intervenes — the offline guarantee for
  // states that are not reliably reproducible live (the v1.3.2 fix holds here).
  test.describe('§C leaked-composer regressions (dry)', () => {
    for (const fx of LEAKED_COMPOSER_FIXTURES) {
      test(`${fx.id}: loaded extension intercepts "${fx.composerSelector}"`, async ({
        context,
      }) => {
        const page = await openFixtureAt(context, fx.origin, readFixtureFile(fx.fixtureFile))
        try {
          const result = await probeLeakedComposer(page, fx.composerSelector)
          expect(
            result.intercepted,
            `${fx.id}: paste on the leaked composer was NOT intercepted (v1.3.2 fix regressed?)`,
          ).toBe(true)
          expect(result.modalAppeared, `${fx.id}: no preview modal on the leaked composer`).toBe(
            true,
          )
        } finally {
          await page.close()
        }
      })
    }
  })
}
