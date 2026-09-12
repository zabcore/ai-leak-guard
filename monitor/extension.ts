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
// the live site. LIVE mode (MONITOR_MODE=live, needs an authenticated
// storageState — see README) skips the interception and hits the real
// site.

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

export const MONITOR_MODE: 'dry' | 'live' = process.env.MONITOR_MODE === 'live' ? 'live' : 'dry'

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
      headless: true,
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

/** Open a surface page (dry-run: fixture served at the real origin). */
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
