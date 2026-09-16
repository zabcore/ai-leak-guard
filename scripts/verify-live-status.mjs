// V1.3.3 Live Gate C — release-candidate gate over the per-route status store.
//
// Reads monitor/status/live-status.json and exits non-zero unless EVERY
// required live route is green: last result PASS, that PASS within 36 h, and at
// least N consecutive passes (default 2 — "two consecutive successful scheduled
// executions"). UNCLASSIFIED, ENV/AUTH-blocked, GAP, skipped (missing), and
// stale routes never count. A CI job of only skipped tests therefore cannot
// read as a pass. Also emits a compact machine-readable summary to stdout.
//
// Pure logic lives in monitor/route-status.ts (unit-tested); this is the thin
// CLI the workflow's release-candidate job runs.

import { evaluateReadiness } from '../monitor/route-status.ts'
import { loadStatus } from '../monitor/route-status-io.ts'
import { REQUIRED_LIVE_ROUTES } from '../monitor/surfaces.ts'
import { resolve } from 'node:path'

const statusPath =
  process.env.LIVE_STATUS_PATH ?? resolve(process.cwd(), 'monitor/status/live-status.json')
const minConsecutive = Number(process.env.LIVE_MIN_CONSECUTIVE ?? '2')

const map = loadStatus(statusPath)
const now = Date.now()
const report = evaluateReadiness(map, REQUIRED_LIVE_ROUTES, now, { minConsecutive })

const summary = {
  ok: report.ok,
  checkedAt: new Date(now).toISOString(),
  statusPath,
  minConsecutive,
  rows: report.rows,
}
console.log(JSON.stringify(summary, null, 2))

if (!report.ok) {
  console.error(
    '[verify-live-status] NOT release-ready — required live routes are not green:\n' +
      report.rows
        .filter((r) => !r.green)
        .map((r) => `  • ${r.routeKey}: ${r.reason}`)
        .join('\n'),
  )
  process.exit(1)
}
console.log('[verify-live-status] OK — all required live routes green (fresh, consecutive passes).')
