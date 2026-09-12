// V1.3.1 §C — Gate C compatibility monitor (Playwright).
//
// Loads the PACKAGED extension and, for every route the §D coverage
// definition describes, drives the gesture on a synthetic fixture at the
// surface's real origin and checks the shipped extension does exactly
// what coverage promises:
//   • a 'supported' route (positive)   → the extension intervenes + warns
//   • an 'unsupported' route (negative) → the extension stays out of the way
//   • 'unvalidated' routes are neither probed nor asserted
//
// Enumeration comes entirely from `buildMonitorPlan()`, so this file never
// hard-codes a surface list — add a surface (with a fixture) or flip a
// flag in coverage and the matrix here follows.

import { test, expect, openSurface } from './extension'
import { buildMonitorPlan, type ProbeRoute } from './coverage-plan'
import { hasFixture } from './surfaces'
import {
  ensureExtensionReady,
  probePaste,
  probeSendEnter,
  probeSendButton,
  probeDocument,
  type ProbeResult,
} from './probes'
import type { Page } from '@playwright/test'

const plan = buildMonitorPlan()

function runProbe(page: Page, route: ProbeRoute): Promise<ProbeResult> {
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
        test(`${probe.route} → ${probe.expect}  [${probe.because}]`, async ({ context }) => {
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
