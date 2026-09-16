// V1.3.3 Live Gate C — the per-route status store must make "absence /
// blocked / never-ran / stale never reads green" true. Pure unit coverage of
// recordResult, the 36 h expiry, and release readiness (incl. the
// two-consecutive-passes gate). Runs in the main vitest gate.

import { describe, expect, it } from 'vitest'
import {
  recordResult,
  isStale,
  isGreen,
  evaluateReadiness,
  STALE_AFTER_MS,
  type RouteStatusMap,
} from '../monitor/route-status'

const T0 = Date.parse('2026-09-15T06:00:00.000Z')
const iso = (ms: number) => new Date(ms).toISOString()

describe('route-status — recordResult', () => {
  it('a PASS sets lastSuccessAt and increments the streak', () => {
    let m: RouteStatusMap = {}
    m = recordResult(m, 'chatgpt:live-noauth', 'PASS', iso(T0))
    expect(m['chatgpt:live-noauth']).toEqual({
      lastAttemptAt: iso(T0),
      lastResult: 'PASS',
      lastSuccessAt: iso(T0),
      consecutivePasses: 1,
    })
    m = recordResult(m, 'chatgpt:live-noauth', 'PASS', iso(T0 + 1000))
    expect(m['chatgpt:live-noauth'].consecutivePasses).toBe(2)
  })

  it('a non-PASS resets the streak but preserves the prior lastSuccessAt', () => {
    let m: RouteStatusMap = {}
    m = recordResult(m, 'r', 'PASS', iso(T0))
    m = recordResult(m, 'r', 'UNCLASSIFIED', iso(T0 + 5000))
    expect(m['r'].consecutivePasses).toBe(0)
    expect(m['r'].lastResult).toBe('UNCLASSIFIED')
    expect(m['r'].lastSuccessAt).toBe(iso(T0)) // preserved
  })

  it('one route does not refresh another', () => {
    let m: RouteStatusMap = {}
    m = recordResult(m, 'a', 'PASS', iso(T0))
    m = recordResult(m, 'b', 'ENV_AUTH_FAILURE', iso(T0 + 1000))
    expect(m['a'].lastResult).toBe('PASS')
    expect(m['b'].lastResult).toBe('ENV_AUTH_FAILURE')
    expect(m['a'].lastAttemptAt).toBe(iso(T0)) // untouched by b's run
  })
})

describe('route-status — 36h expiry + green', () => {
  it('a PASS within 36h is green; older than 36h is stale, not green', () => {
    const fresh = recordResult({}, 'r', 'PASS', iso(T0))['r']
    expect(isStale(fresh, T0 + STALE_AFTER_MS - 1)).toBe(false)
    expect(isGreen(fresh, T0 + STALE_AFTER_MS - 1)).toBe(true)
    // Just past 36h → stale, never green.
    expect(isStale(fresh, T0 + STALE_AFTER_MS + 1)).toBe(true)
    expect(isGreen(fresh, T0 + STALE_AFTER_MS + 1)).toBe(false)
  })

  it('a missing route is stale and not green', () => {
    expect(isStale(undefined, T0)).toBe(true)
    expect(isGreen(undefined, T0)).toBe(false)
  })

  it('UNCLASSIFIED / ENV_AUTH_FAILURE / GAP are never green even when recent', () => {
    for (const result of ['UNCLASSIFIED', 'ENV_AUTH_FAILURE', 'GAP', 'PRODUCT_FAILURE'] as const) {
      const e = recordResult({}, 'r', result, iso(T0))['r']
      expect(isGreen(e, T0 + 1000)).toBe(false)
    }
  })
})

describe('route-status — release readiness', () => {
  const required = ['chatgpt:live-noauth', 'perplexity:live-noauth']

  it('ok only when every required route is green with >= 2 consecutive passes', () => {
    let m: RouteStatusMap = {}
    for (const r of required) {
      m = recordResult(m, r, 'PASS', iso(T0))
      m = recordResult(m, r, 'PASS', iso(T0 + 1000))
    }
    const report = evaluateReadiness(m, required, T0 + 2000)
    expect(report.ok).toBe(true)
    expect(report.rows.every((row) => row.green)).toBe(true)
  })

  it('a single pass is not enough (needs two consecutive)', () => {
    let m: RouteStatusMap = {}
    for (const r of required) m = recordResult(m, r, 'PASS', iso(T0))
    const report = evaluateReadiness(m, required, T0 + 1000)
    expect(report.ok).toBe(false)
    for (const row of report.rows) expect(row.reason).toMatch(/consecutive/)
  })

  it('a skipped-only run (no results recorded) is never ready', () => {
    const report = evaluateReadiness({}, required, T0)
    expect(report.ok).toBe(false)
    for (const row of report.rows) expect(row.reason).toBe('no run recorded')
  })

  it('a route that passed twice but > 36h ago is stale → not ready', () => {
    let m: RouteStatusMap = {}
    for (const r of required) {
      m = recordResult(m, r, 'PASS', iso(T0))
      m = recordResult(m, r, 'PASS', iso(T0 + 1000))
    }
    const report = evaluateReadiness(m, required, T0 + STALE_AFTER_MS + 5000)
    expect(report.ok).toBe(false)
    for (const row of report.rows) expect(row.stale).toBe(true)
  })

  it('one blocked route sinks readiness without touching the other', () => {
    let m: RouteStatusMap = {}
    m = recordResult(m, 'chatgpt:live-noauth', 'PASS', iso(T0))
    m = recordResult(m, 'chatgpt:live-noauth', 'PASS', iso(T0 + 1000))
    m = recordResult(m, 'perplexity:live-noauth', 'ENV_AUTH_FAILURE', iso(T0 + 1000))
    const report = evaluateReadiness(m, required, T0 + 2000)
    expect(report.ok).toBe(false)
    const perplexity = report.rows.find((r) => r.routeKey === 'perplexity:live-noauth')!
    expect(perplexity.green).toBe(false)
    const chatgpt = report.rows.find((r) => r.routeKey === 'chatgpt:live-noauth')!
    expect(chatgpt.green).toBe(true)
  })
})
