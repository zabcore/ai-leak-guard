// V1.3.1 §C monitor — the Playwright harness that loads the PACKAGED
// extension and opens a surface.
//
// Chrome only runs an extension from a persistent context launched with
// --load-extension, so the `context` fixture is overridden to do exactly
// that against the built `dist/`. `openSurface` then opens the surface's
// real origin; in the default DRY-RUN mode every request to that origin
// is fulfilled locally with the synthetic fixture (no network, no
// credentials), and because the committed URL is still the real https
// origin, the packaged content script injects precisely as it would on
// the live site.
//
// Non-dry modes skip the interception and hit the REAL site:
//   • LIVE-NOAUTH (MONITOR_MODE=live-noauth) — navigates the real
//     logged-out origins (chatgpt.com, perplexity.ai, and pre-hydration
//     composer states). No credentials. This is the drift detector for the
//     exact states that leaked to users; see `openLiveNoauthPage` +
//     `probeLiveNoauth`.
//   • LIVE (MONITOR_MODE=live) — the authenticated variant, needs a
//     storageState (see README); reserved for once test accounts exist.

import {
  test as base,
  expect,
  chromium,
  type BrowserContext,
  type Page,
  type Worker,
} from '@playwright/test'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fixtureHtml, navigationUrl } from './surfaces'
import type { SurfacePlan } from './coverage-plan'

const HERE = dirname(fileURLToPath(import.meta.url))
const DIST = resolve(HERE, '..', 'dist')

export type MonitorMode = 'dry' | 'live' | 'live-noauth'

export const MONITOR_MODE: MonitorMode =
  process.env.MONITOR_MODE === 'live'
    ? 'live'
    : process.env.MONITOR_MODE === 'live-noauth'
      ? 'live-noauth'
      : 'dry'

/** `https://host/*` (a coverage/manifest match) → a Playwright route glob. */
function routeGlob(origin: string): string {
  return origin.replace(/\/\*$/, '/**')
}

export const test = base.extend<{ context: BrowserContext }>({
  context: async ({}, use, testInfo) => {
    const userDataDir = resolve(testInfo.project.outputDir, `udd-${testInfo.workerIndex}`)
    const args = [
      `--disable-extensions-except=${DIST}`,
      `--load-extension=${DIST}`,
      '--headless=new',
    ]
    // CI containers usually need --no-sandbox; set MONITOR_NO_SANDBOX=0 to opt out.
    if (process.env.MONITOR_NO_SANDBOX !== '0') args.push('--no-sandbox')

    const context = await chromium.launchPersistentContext(userDataDir, {
      // MUST be `false`: with `headless: true` Playwright launches the
      // headless SHELL binary, which cannot load an MV3 extension — the
      // service worker never starts and every probe hangs (the CI failure).
      // `false` selects the FULL Chromium; `--headless=new` in `args` runs
      // it headless (extension-capable, needs no display) in CI.
      headless: false,
      // In this environment the pre-installed Chromium is set via
      // MONITOR_CHROMIUM; in CI Playwright resolves its own managed build,
      // so leave executablePath undefined when the var is absent.
      executablePath: process.env.MONITOR_CHROMIUM || undefined,
      args,
    })

    let sw: Worker | undefined = context.serviceWorkers()[0]
    if (sw === undefined) {
      sw = await context.waitForEvent('serviceworker', { timeout: 20_000 }).catch(() => undefined)
    }
    if (sw === undefined) {
      throw new Error(
        'Extension service worker never started — the packaged extension in dist/ failed to load (run `npm run build` first).',
      )
    }

    await use(context)
    await context.close()
  },
})

export { expect }

/**
 * Open a surface page. In dry-run the fixture is served at the real origin
 * via request interception; in any live mode the interception is skipped and
 * the real site is loaded.
 */
export async function openSurface(context: BrowserContext, plan: SurfacePlan): Promise<Page> {
  const page = await context.newPage()
  if (MONITOR_MODE === 'dry') {
    const body = fixtureHtml(plan.id)
    for (const origin of plan.origins) {
      await page.route(routeGlob(origin), (route) =>
        route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body }),
      )
    }
  }
  await page.goto(navigationUrl(plan.origins), { waitUntil: 'domcontentloaded' })
  return page
}

/**
 * Open a REAL logged-out URL for the live-noauth drift monitor — no request
 * interception, no credentials. A navigation error (timeout, DNS, an
 * interstitial that never settles) is swallowed here on purpose: the page is
 * returned regardless, and `probeLiveNoauth` classifies "no composer found"
 * as an ENVIRONMENT/AUTH failure rather than crashing the run with an opaque
 * stack. The run is still red — a non-PASS never reads green.
 */
export async function openLiveNoauthPage(context: BrowserContext, url: string): Promise<Page> {
  const page = await context.newPage()
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {
    /* classified downstream as ENV/AUTH when no composer appears */
  })
  return page
}
