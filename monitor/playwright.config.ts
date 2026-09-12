// V1.3.1 §C — Playwright config for the Gate C coverage monitor.
//
// Runs ONLY monitor.spec.ts. A single worker: one persistent context
// with the loaded extension, exercised deterministically (the surfaces
// share it, each probe on its own fresh page). Kept out of the main
// `npm test` (vitest) — invoked via `npm run monitor`.

import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: '.',
  testMatch: /monitor\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 8_000 },
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]]
    : [['list']],
  outputDir: 'test-results',
  use: {
    trace: process.env.CI ? 'retain-on-failure' : 'off',
  },
})
