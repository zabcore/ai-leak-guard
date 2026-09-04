// @vitest-environment jsdom
//
// V1.3 M1 — submit-scan core state machine tests.
//
// Every bullet in the M1 build instruction is a `describe` below.
// The one that outranks the rest is "DECISION never auto-sends":
// with the decision seam never resolving, advancing fake timers
// past every budget in the module must leave the send HELD with
// zero submissions; a liveness guard, if enabled, may only ever
// land on RETURNED_TO_EDIT.
//
// No real site adapter exists in M1; every flow runs through
// `FakeSubmitAdapter`, and the flag is enabled per-test via the
// injected `isEnabled` seam (the compile-time default is OFF and is
// asserted as such).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DECISION_LIVENESS_MS,
  RESUME_FAILURE_KILL_THRESHOLD,
  SCAN_WATCHDOG_MS,
  SubmitCore,
  createIdempotentResume,
  type DecisionSummary,
  type ScanOutcome,
  type SubmitCoreDeps,
  type SubmitState,
  type UserDecision,
} from '../src/content/submit/submit-core'
import { isSubmitProtectionEnabled } from '../src/content/submit/submit-flag'
import { fingerprintFindings } from '../src/content/submit/fingerprint'
import { detectDetailed } from '../src/detector/engine'
import { DetectorCategory } from '../src/detector/types'
import type { AlgEvent } from '../src/shared/event-log'
import { getSubmitKillSwitch } from '../src/shared/storage'
import { FakeSubmitAdapter } from './helpers/fake-submit-adapter'

const SSN_TEXT = 'Patient SSN is 123-45-6789 and please summarise'
const CLEAN_TEXT = 'What is the capital of France? Please be brief.'
// Second SSN must pass isValidSsn (area 900-999 is never issued and is rejected).
const TWO_SSN_TEXT = 'SSN 123-45-6789 and SSN 321-54-9876'

// A decision seam that hands the test the resolver — the test decides
// WHEN (or whether) the user chooses.
function controllableDecide(): {
  decide: SubmitCoreDeps['decide']
  resolve: (d: UserDecision) => void
  reject: (e: Error) => void
  summaries: DecisionSummary[]
  calls: number
} {
  const h = {
    summaries: [] as DecisionSummary[],
    calls: 0,
    resolve: (_d: UserDecision) => {},
    reject: (_e: Error) => {},
    decide: (s: DecisionSummary) =>
      new Promise<UserDecision>((res, rej) => {
        h.calls += 1
        h.summaries.push(s)
        h.resolve = res
        h.reject = rej
      }),
  }
  return h
}

function makeCore(overrides: Partial<SubmitCoreDeps> = {}) {
  const transitions: Array<{ key: string; from: SubmitState; to: SubmitState }> = []
  const logged: AlgEvent[] = []
  const core = new SubmitCore({
    isEnabled: () => true,
    setTimer: (fn, ms) => setTimeout(fn, ms) as unknown as number,
    clearTimer: (id) => clearTimeout(id),
    logSiteId: 'chatgpt',
    logEvent: (e) => logged.push(e),
    reportAdapterDisabled: () => {},
    onTransition: (key, from, to) => transitions.push({ key, from, to }),
    ...overrides,
  })
  return { core, transitions, logged }
}

const intent = { composerKey: 'composer-1' }

// Let the core's microtask chain drain without advancing timers.
async function flush(n = 6): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

// ─────────────────────────────────────────────────────────────────────

describe('flag', () => {
  it('compile-time default is OFF and the core does not take the send', async () => {
    expect(isSubmitProtectionEnabled()).toBe(false)
    const core = new SubmitCore() // real default deps → real flag
    const adapter = new FakeSubmitAdapter({ text: SSN_TEXT })
    const out = await core.handleSendIntent(adapter, intent)
    expect(out.handled).toBe(false)
    expect(out.route).toBe('flag-off')
    expect(out.state).toBe('IDLE')
    expect(adapter.resumeCalls).toBe(0)
    expect(adapter.readCalls).toBe(0)
  })

  it('globalThis override flips it on without touching the file', () => {
    ;(globalThis as { __AI_LEAK_GUARD_SUBMIT_FLAG__?: boolean }).__AI_LEAK_GUARD_SUBMIT_FLAG__ =
      true
    try {
      expect(isSubmitProtectionEnabled()).toBe(true)
    } finally {
      delete (globalThis as { __AI_LEAK_GUARD_SUBMIT_FLAG__?: boolean })
        .__AI_LEAK_GUARD_SUBMIT_FLAG__
    }
    expect(isSubmitProtectionEnabled()).toBe(false)
  })
})

describe('clean scan → resume → exactly one submit', () => {
  it('auto-proceeds with no decision UI and one resume() call', async () => {
    const h = controllableDecide()
    const { core, transitions, logged } = makeCore({ decide: h.decide })
    const adapter = new FakeSubmitAdapter({ text: CLEAN_TEXT })
    const out = await core.handleSendIntent(adapter, intent)
    expect(out).toMatchObject({
      handled: true,
      state: 'SUBMITTED',
      route: 'clean',
      submitted: true,
      failedOpen: false,
    })
    expect(adapter.resumeCalls).toBe(1)
    expect(h.calls).toBe(0)
    expect(transitions.map((t) => t.to)).toEqual(['HELD_SCANNING', 'RESUMING', 'SUBMITTED'])
    expect(logged.map((e) => e.action)).toEqual(['auto-cleared'])
    expect(logged[0].eventType).toBe('submit')
  })
})

describe('sensitive → DECISION', () => {
  it('proceed → exactly one submit, fingerprint acknowledged, as-is logged', async () => {
    const h = controllableDecide()
    const { core, transitions, logged } = makeCore({ decide: h.decide })
    const adapter = new FakeSubmitAdapter({ text: SSN_TEXT })
    const p = core.handleSendIntent(adapter, intent)
    await flush()
    expect(core.getState(intent)).toBe('DECISION')
    expect(adapter.resumeCalls).toBe(0)
    expect(h.summaries[0]).toMatchObject({
      composerKey: 'composer-1',
      count: 1,
      hadCriticalOrHigh: true,
      changedSinceAcknowledged: false,
    })
    expect(h.summaries[0].categories).toEqual([DetectorCategory.GOVERNMENT_FINANCIAL])
    h.resolve('proceed')
    const out = await p
    expect(out).toMatchObject({ state: 'SUBMITTED', route: 'proceed', submitted: true })
    expect(adapter.resumeCalls).toBe(1)
    expect(core.hasAcknowledged(intent, h.summaries[0].fingerprint)).toBe(true)
    expect(transitions.map((t) => t.to)).toEqual([
      'HELD_SCANNING',
      'DECISION',
      'RESUMING',
      'SUBMITTED',
    ])
    expect(logged.map((e) => e.action)).toEqual(['as-is'])
  })

  it('return-to-edit → zero submits, draft intact, cancelled logged', async () => {
    const h = controllableDecide()
    const { core, transitions, logged } = makeCore({ decide: h.decide })
    const adapter = new FakeSubmitAdapter({ text: SSN_TEXT })
    const p = core.handleSendIntent(adapter, intent)
    await flush()
    h.resolve('return-to-edit')
    const out = await p
    expect(out).toMatchObject({
      state: 'RETURNED_TO_EDIT',
      route: 'return-to-edit',
      submitted: false,
    })
    expect(adapter.resumeCalls).toBe(0)
    // The core never touches the draft.
    expect(adapter.text).toBe(SSN_TEXT)
    expect(core.hasAcknowledged(intent, h.summaries[0].fingerprint)).toBe(false)
    expect(transitions.map((t) => t.to)).toEqual(['HELD_SCANNING', 'DECISION', 'RETURNED_TO_EDIT'])
    expect(logged.map((e) => e.action)).toEqual(['cancelled'])
  })
})

describe('Watchdog-A (scan) expiry → FAILED_OPEN → proceed + incomplete-protection event', () => {
  it('a scan that never resolves is cut off at SCAN_WATCHDOG_MS and the send proceeds', async () => {
    const h = controllableDecide()
    const { core, transitions, logged } = makeCore({
      decide: h.decide,
      scan: () => new Promise<ScanOutcome>(() => {}), // hangs forever
    })
    const adapter = new FakeSubmitAdapter({ text: SSN_TEXT })
    const p = core.handleSendIntent(adapter, intent)
    await flush()
    expect(core.getState(intent)).toBe('HELD_SCANNING')
    expect(adapter.resumeCalls).toBe(0)
    vi.advanceTimersByTime(SCAN_WATCHDOG_MS - 1)
    await flush()
    expect(adapter.resumeCalls).toBe(0)
    vi.advanceTimersByTime(1)
    const out = await p
    expect(out).toMatchObject({
      state: 'SUBMITTED',
      route: 'failed-open',
      failedOpen: true,
      submitted: true,
    })
    expect(adapter.resumeCalls).toBe(1)
    expect(h.calls).toBe(0)
    expect(transitions.map((t) => t.to)).toEqual([
      'HELD_SCANNING',
      'FAILED_OPEN',
      'RESUMING',
      'SUBMITTED',
    ])
    expect(logged).toHaveLength(1)
    expect(logged[0]).toMatchObject({
      eventType: 'submit',
      action: 'unable-to-inspect',
      categories: [],
      count: 0,
      hadCriticalOrHigh: false,
    })
  })

  it('a scan that resolves inside the budget clears the watchdog (no spurious fail-open)', async () => {
    const { core } = makeCore({
      scan: (text) =>
        new Promise<ScanOutcome>((res) =>
          setTimeout(() => res(detectDetailed(text)), SCAN_WATCHDOG_MS - 50),
        ),
    })
    const adapter = new FakeSubmitAdapter({ text: CLEAN_TEXT })
    const p = core.handleSendIntent(adapter, intent)
    await flush() // let the scan register its own (fake) timer
    vi.advanceTimersByTime(SCAN_WATCHDOG_MS - 50)
    const out = await p
    expect(out).toMatchObject({ state: 'SUBMITTED', route: 'clean', failedOpen: false })
    vi.advanceTimersByTime(10_000)
    expect(adapter.resumeCalls).toBe(1)
  })
})

describe('DECISION never auto-sends (the invariant that outranks everything)', () => {
  it('module default: no liveness guard at all', () => {
    expect(DECISION_LIVENESS_MS).toBeNull()
  })

  it('with the user never choosing, advancing past every budget leaves the send HELD with zero submissions', async () => {
    const h = controllableDecide() // never resolved
    const { core, transitions } = makeCore({ decide: h.decide })
    const adapter = new FakeSubmitAdapter({ text: SSN_TEXT })
    const p = core.handleSendIntent(adapter, intent)
    await flush()
    expect(core.getState(intent)).toBe('DECISION')
    // Past the scan watchdog, past the kill threshold × anything, past an hour.
    vi.advanceTimersByTime(SCAN_WATCHDOG_MS * 100)
    await flush()
    vi.advanceTimersByTime(60 * 60 * 1000)
    await flush()
    expect(core.getState(intent)).toBe('DECISION')
    expect(adapter.resumeCalls).toBe(0)
    expect(transitions.map((t) => t.to)).toEqual(['HELD_SCANNING', 'DECISION'])
    // The promise is still pending — nothing resolved it.
    let settled = false
    void p.then(() => {
      settled = true
    })
    await flush()
    expect(settled).toBe(false)
    // Draft untouched.
    expect(adapter.text).toBe(SSN_TEXT)
  })

  it('if a liveness guard is enabled, its ONLY outcome is RETURNED_TO_EDIT — never SUBMITTED', async () => {
    const h = controllableDecide() // never resolved
    const { core, transitions, logged } = makeCore({ decide: h.decide, decisionLivenessMs: 30_000 })
    const adapter = new FakeSubmitAdapter({ text: SSN_TEXT })
    const p = core.handleSendIntent(adapter, intent)
    await flush()
    vi.advanceTimersByTime(29_999)
    await flush()
    expect(core.getState(intent)).toBe('DECISION')
    vi.advanceTimersByTime(1)
    const out = await p
    expect(out).toMatchObject({
      state: 'RETURNED_TO_EDIT',
      route: 'liveness-cancel',
      submitted: false,
    })
    expect(adapter.resumeCalls).toBe(0)
    expect(transitions.map((t) => t.to)).toEqual(['HELD_SCANNING', 'DECISION', 'RETURNED_TO_EDIT'])
    expect(logged.map((e) => e.action)).toEqual(['cancelled'])
    // A late "proceed" from the (dead) UI must not resurrect the send.
    h.resolve('proceed')
    await flush()
    vi.advanceTimersByTime(10_000)
    expect(adapter.resumeCalls).toBe(0)
  })

  it('a throw inside the decision UI lands on RETURNED_TO_EDIT, not a submit', async () => {
    const h = controllableDecide()
    const { core, logged } = makeCore({ decide: h.decide })
    const adapter = new FakeSubmitAdapter({ text: SSN_TEXT })
    const p = core.handleSendIntent(adapter, intent)
    await flush()
    h.reject(new Error('modal exploded'))
    const out = await p
    expect(out).toMatchObject({
      state: 'RETURNED_TO_EDIT',
      route: 'decision-error',
      submitted: false,
    })
    expect(adapter.resumeCalls).toBe(0)
    expect(logged.map((e) => e.action)).toEqual(['cancelled'])
  })
})

describe('throw injected in each automated phase → FAILED_OPEN → proceeds; never stuck, never double-send', () => {
  it('readComposerText throws', async () => {
    const h = controllableDecide()
    const { core, transitions, logged } = makeCore({ decide: h.decide })
    const adapter = new FakeSubmitAdapter({ text: SSN_TEXT })
    adapter.readThrows = new Error('composer unmounted')
    const out = await core.handleSendIntent(adapter, intent)
    expect(out).toMatchObject({ state: 'SUBMITTED', route: 'failed-open', failedOpen: true })
    expect(adapter.resumeCalls).toBe(1)
    expect(h.calls).toBe(0)
    expect(transitions.map((t) => t.to)).toEqual([
      'HELD_SCANNING',
      'FAILED_OPEN',
      'RESUMING',
      'SUBMITTED',
    ])
    expect(logged.map((e) => e.action)).toEqual(['unable-to-inspect'])
  })

  it('scan throws synchronously', async () => {
    const { core } = makeCore({
      scan: () => {
        throw new Error('detector exploded')
      },
    })
    const adapter = new FakeSubmitAdapter({ text: SSN_TEXT })
    const out = await core.handleSendIntent(adapter, intent)
    expect(out).toMatchObject({ state: 'SUBMITTED', route: 'failed-open', failedOpen: true })
    expect(adapter.resumeCalls).toBe(1)
  })

  it('scan rejects asynchronously', async () => {
    const { core } = makeCore({ scan: () => Promise.reject(new Error('async boom')) })
    const adapter = new FakeSubmitAdapter({ text: SSN_TEXT })
    const out = await core.handleSendIntent(adapter, intent)
    expect(out).toMatchObject({ state: 'SUBMITTED', route: 'failed-open', failedOpen: true })
    expect(adapter.resumeCalls).toBe(1)
  })

  it('resume() throws → treated as failed, below threshold → RETURNED_TO_EDIT, never stuck', async () => {
    const { core } = makeCore()
    const adapter = new FakeSubmitAdapter({ text: CLEAN_TEXT })
    adapter.resumeThrows = new Error('button vanished')
    const out = await core.handleSendIntent(adapter, intent)
    expect(out).toMatchObject({
      state: 'RETURNED_TO_EDIT',
      route: 'clean',
      resumeResult: 'failed',
      submitted: false,
    })
    expect(adapter.resumeCalls).toBe(1)
    expect(core.getState(intent)).toBe('RETURNED_TO_EDIT')
  })

  it('fallback resume is tried once when the adapter fails, and counts as submitted', async () => {
    const fallback = vi.fn(() => 'submitted' as const)
    const { core } = makeCore({ fallbackResume: fallback })
    const adapter = new FakeSubmitAdapter({ text: CLEAN_TEXT, resume: ['failed'] })
    const out = await core.handleSendIntent(adapter, intent)
    expect(out).toMatchObject({ state: 'SUBMITTED', resumeResult: 'submitted' })
    expect(adapter.resumeCalls).toBe(1)
    expect(fallback).toHaveBeenCalledTimes(1)
  })
})

describe("resume() returns 'failed' N times → kill switch → ADAPTER_DISABLED + popup flag", () => {
  it('engages at RESUME_FAILURE_KILL_THRESHOLD, reports the adapter, and stops taking sends', async () => {
    const reported: string[] = []
    const { core, transitions } = makeCore({ reportAdapterDisabled: (id) => reported.push(id) })
    const adapter = new FakeSubmitAdapter({ id: 'chatgpt', text: CLEAN_TEXT, resume: ['failed'] })
    const outs = []
    for (let i = 0; i < RESUME_FAILURE_KILL_THRESHOLD; i++) {
      outs.push(await core.handleSendIntent(adapter, intent))
    }
    for (let i = 0; i < RESUME_FAILURE_KILL_THRESHOLD - 1; i++) {
      expect(outs[i]).toMatchObject({ state: 'RETURNED_TO_EDIT', resumeResult: 'failed' })
    }
    expect(outs[RESUME_FAILURE_KILL_THRESHOLD - 1]).toMatchObject({
      state: 'ADAPTER_DISABLED',
      handled: true,
    })
    expect(reported).toEqual(['chatgpt'])
    expect(core.isAdapterDisabled('chatgpt')).toBe(true)
    expect(transitions.at(-1)?.to).toBe('ADAPTER_DISABLED')
    // Next intent: not handled — the adapter must let the native send through.
    const callsBefore = adapter.resumeCalls
    const next = await core.handleSendIntent(adapter, intent)
    expect(next).toMatchObject({
      handled: false,
      state: 'ADAPTER_DISABLED',
      route: 'adapter-disabled',
    })
    expect(adapter.resumeCalls).toBe(callsBefore)
  })

  it('a success in between resets the counter', async () => {
    const reported: string[] = []
    const { core } = makeCore({ reportAdapterDisabled: (id) => reported.push(id) })
    const adapter = new FakeSubmitAdapter({
      id: 'claude',
      text: CLEAN_TEXT,
      resume: ['failed', 'failed', 'submitted', 'failed', 'failed', 'submitted'],
    })
    for (let i = 0; i < 6; i++) await core.handleSendIntent(adapter, intent)
    expect(reported).toEqual([])
    expect(core.isAdapterDisabled('claude')).toBe(false)
  })

  it('default reportAdapterDisabled writes ONLY {adapterId, ts} to storage (popup flag)', async () => {
    const reported: string[] = []
    // Use the real default reporter by not overriding it.
    const { core } = makeCore({ reportAdapterDisabled: undefined as never })
    const setSpy = vi.spyOn(chrome.storage.local, 'set')
    const adapter = new FakeSubmitAdapter({ id: 'gemini', text: CLEAN_TEXT, resume: ['failed'] })
    for (let i = 0; i < RESUME_FAILURE_KILL_THRESHOLD; i++)
      await core.handleSendIntent(adapter, intent)
    await flush(20)
    const flag = await getSubmitKillSwitch()
    expect(flag).not.toBeNull()
    expect(flag?.adapterId).toBe('gemini')
    expect(typeof flag?.ts).toBe('number')
    const killWrites = setSpy.mock.calls.filter((c) => 'submitKillSwitch' in (c[0] as object))
    expect(killWrites).toHaveLength(1)
    expect(
      Object.keys((killWrites[0][0] as { submitKillSwitch: object }).submitKillSwitch).sort(),
    ).toEqual(['adapterId', 'ts'])
    expect(reported).toEqual([])
  })
})

describe('re-entrancy', () => {
  it('two intents during HELD → one submission; second intent coalesces onto the first', async () => {
    const { core } = makeCore({
      scan: (t) => new Promise<ScanOutcome>((r) => setTimeout(() => r(detectDetailed(t)), 100)),
    })
    const adapter = new FakeSubmitAdapter({ text: CLEAN_TEXT })
    const p1 = core.handleSendIntent(adapter, intent)
    const p2 = core.handleSendIntent(adapter, intent)
    expect(p2).toBe(p1)
    await flush() // scan timer registers in a microtask
    expect(core.getState(intent)).toBe('HELD_SCANNING')
    vi.advanceTimersByTime(100)
    const [o1, o2] = await Promise.all([p1, p2])
    expect(o1).toBe(o2)
    expect(o1.coalescedIntents).toBe(1)
    expect(adapter.resumeCalls).toBe(1)
  })

  it('two intents during DECISION → one submission after proceed', async () => {
    const h = controllableDecide()
    const { core } = makeCore({ decide: h.decide })
    const adapter = new FakeSubmitAdapter({ text: SSN_TEXT })
    const p1 = core.handleSendIntent(adapter, intent)
    await flush()
    expect(core.getState(intent)).toBe('DECISION')
    const p2 = core.handleSendIntent(adapter, intent)
    const p3 = core.handleSendIntent(adapter, intent)
    expect(h.calls).toBe(1)
    h.resolve('proceed')
    const outs = await Promise.all([p1, p2, p3])
    expect(new Set(outs).size).toBe(1)
    expect(outs[0].coalescedIntents).toBe(2)
    expect(adapter.resumeCalls).toBe(1)
  })

  it('different composers are independent in-flight sends', async () => {
    const h = controllableDecide()
    const { core } = makeCore({ decide: h.decide })
    const a = new FakeSubmitAdapter({ text: CLEAN_TEXT })
    const p1 = core.handleSendIntent(a, { composerKey: 'c1' })
    const p2 = core.handleSendIntent(a, { composerKey: 'c2' })
    expect(p2).not.toBe(p1)
    await Promise.all([p1, p2])
    expect(a.resumeCalls).toBe(2)
  })

  it('the resume closure is idempotent: called twice → adapter.resume() once', () => {
    const adapter = new FakeSubmitAdapter({ resume: ['submitted'] })
    const once = createIdempotentResume(adapter)
    expect(once()).toBe('submitted')
    expect(once()).toBe('submitted')
    expect(once()).toBe('submitted')
    expect(adapter.resumeCalls).toBe(1)
  })

  it('idempotent closure caches a failure too (no retry storm)', () => {
    const fallback = vi.fn(() => 'failed' as const)
    const adapter = new FakeSubmitAdapter({ resume: ['failed'] })
    const once = createIdempotentResume(adapter, fallback)
    expect(once()).toBe('failed')
    expect(once()).toBe('failed')
    expect(adapter.resumeCalls).toBe(1)
    expect(fallback).toHaveBeenCalledTimes(1)
  })
})

describe('dedup (risk-shape fingerprint, in-memory only)', () => {
  it('fingerprint is category→count, sorted, content-free', () => {
    const fp = fingerprintFindings(detectDetailed(TWO_SSN_TEXT).findings)
    expect(fp).toBe(`${DetectorCategory.GOVERNMENT_FINANCIAL}:2`)
    expect(fp).not.toContain('123')
    expect(fingerprintFindings([])).toBe('none')
  })

  it('an acknowledged fingerprint suppresses the second identical warn (modal skipped)', async () => {
    const h = controllableDecide()
    const { core, logged } = makeCore({ decide: h.decide })
    const adapter = new FakeSubmitAdapter({ text: SSN_TEXT })
    const p1 = core.handleSendIntent(adapter, intent)
    await flush()
    h.resolve('proceed')
    await p1
    expect(h.calls).toBe(1)
    // Same risk shape (different SSN — intentional trade-off: shape, not identity).
    adapter.text = 'Their SSN is 321-54-9876 today'
    const out2 = await core.handleSendIntent(adapter, intent)
    expect(out2).toMatchObject({ state: 'SUBMITTED', route: 'dedup-skip' })
    expect(h.calls).toBe(1)
    expect(adapter.resumeCalls).toBe(2)
    expect(logged.map((e) => e.action)).toEqual(['as-is', 'as-is'])
  })

  it('a changed count re-warns, and reports the change', async () => {
    const h = controllableDecide()
    const { core } = makeCore({ decide: h.decide })
    const adapter = new FakeSubmitAdapter({ text: SSN_TEXT })
    const p1 = core.handleSendIntent(adapter, intent)
    await flush()
    h.resolve('proceed')
    await p1
    adapter.text = TWO_SSN_TEXT
    const p2 = core.handleSendIntent(adapter, intent)
    await flush()
    expect(h.calls).toBe(2)
    expect(h.summaries[1]).toMatchObject({ count: 2, changedSinceAcknowledged: true })
    h.resolve('return-to-edit')
    const out2 = await p2
    expect(out2.state).toBe('RETURNED_TO_EDIT')
    expect(adapter.resumeCalls).toBe(1)
  })

  it('a changed category re-warns', async () => {
    const h = controllableDecide()
    const { core } = makeCore({ decide: h.decide })
    const adapter = new FakeSubmitAdapter({ text: SSN_TEXT })
    const p1 = core.handleSendIntent(adapter, intent)
    await flush()
    h.resolve('proceed')
    await p1
    adapter.text = 'Provider NPI 1234567893 on file for review'
    const p2 = core.handleSendIntent(adapter, intent)
    await flush()
    expect(h.calls).toBe(2)
    expect(h.summaries[1].categories).toEqual([DetectorCategory.PROVIDER_ID])
    h.resolve('return-to-edit')
    await p2
  })

  it('acknowledgement is scoped to (tab, composer)', async () => {
    const h = controllableDecide()
    const { core } = makeCore({ decide: h.decide })
    const adapter = new FakeSubmitAdapter({ text: SSN_TEXT })
    const p1 = core.handleSendIntent(adapter, { composerKey: 'c1', tabKey: 't1' })
    await flush()
    h.resolve('proceed')
    await p1
    const p2 = core.handleSendIntent(adapter, { composerKey: 'c1', tabKey: 't2' })
    await flush()
    expect(h.calls).toBe(2)
    h.resolve('return-to-edit')
    await p2
  })

  it('RELEASE BLOCKER: chrome.storage.local.set never receives a fingerprint (even with logging on)', async () => {
    const setSpy = vi.spyOn(chrome.storage.local, 'set')
    const h = controllableDecide()
    // Real default logEvent → real appendEvent → shim service worker → storage.set
    const { core } = makeCore({
      decide: h.decide,
      logEvent: undefined as never,
      logSiteId: 'chatgpt',
    })
    const adapter = new FakeSubmitAdapter({ text: TWO_SSN_TEXT })
    const p1 = core.handleSendIntent(adapter, intent)
    await flush()
    h.resolve('proceed')
    await p1
    await core.handleSendIntent(adapter, intent) // dedup-skip path
    await flush(20)
    const fp = h.summaries[0].fingerprint
    expect(fp).toBe(`${DetectorCategory.GOVERNMENT_FINANCIAL}:2`)
    expect(setSpy).toHaveBeenCalled() // logging did reach storage…
    for (const call of setSpy.mock.calls) {
      const json = JSON.stringify(call[0])
      expect(json).not.toContain(fp) // …but never a fingerprint,
      expect(json).not.toContain('fingerprint')
      expect(json).not.toContain('123-45-6789') // …and never content.
      expect(json).not.toContain('321-54-9876')
    }
    const stored = await chrome.storage.local.get(null)
    expect(JSON.stringify(stored)).not.toContain(fp)
  })
})

describe('no-content guard', () => {
  it('no logged event carries raw composer text, matched values, or any field beyond the seven', async () => {
    const h = controllableDecide()
    const { core, logged } = makeCore({ decide: h.decide })
    const adapter = new FakeSubmitAdapter({ text: SSN_TEXT })
    // sensitive → return-to-edit
    let p = core.handleSendIntent(adapter, intent)
    await flush()
    h.resolve('return-to-edit')
    await p
    // sensitive → proceed
    p = core.handleSendIntent(adapter, intent)
    await flush()
    h.resolve('proceed')
    await p
    // clean
    adapter.text = CLEAN_TEXT
    await core.handleSendIntent(adapter, intent)
    // failed-open
    adapter.text = SSN_TEXT
    adapter.readThrows = new Error('x')
    await core.handleSendIntent(adapter, intent)

    expect(logged.map((e) => e.action)).toEqual([
      'cancelled',
      'as-is',
      'auto-cleared',
      'unable-to-inspect',
    ])
    for (const e of logged) {
      expect(Object.keys(e).sort()).toEqual(
        ['action', 'categories', 'count', 'eventType', 'hadCriticalOrHigh', 'site', 'ts'].sort(),
      )
      const json = JSON.stringify(e)
      expect(json).not.toContain('123-45-6789')
      expect(json).not.toContain('Patient')
      expect(json).not.toContain('France')
      expect(e.eventType).toBe('submit')
    }
    // Decision summaries handed to the UI are metadata-only too.
    for (const s of h.summaries) {
      expect(JSON.stringify(s)).not.toContain('123-45-6789')
      expect(s).not.toHaveProperty('text')
      expect(s).not.toHaveProperty('findings')
    }
  })

  it('logSiteId "" skips logging entirely', async () => {
    const { core, logged } = makeCore({ logSiteId: '' })
    await core.handleSendIntent(new FakeSubmitAdapter({ text: CLEAN_TEXT }), intent)
    expect(logged).toEqual([])
  })
})
