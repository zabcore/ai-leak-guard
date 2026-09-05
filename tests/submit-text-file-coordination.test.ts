// @vitest-environment jsdom
//
// V1.3 M4 — "Text/file coordination at send. Single combined modal."
//
// The SEND is the final orchestration point: it must reconcile the
// typed TEXT (submit-scan) with any attached FILE the V1.2 document
// flow inspected at ATTACH time (published to the document gate). These
// tests drive the §9 Files matrix end-to-end through `SubmitCore` with
// an injected fake gate, plus a jsdom render of the ONE combined modal.
//
// Release blocker §10.6 is the headline: text AND a flagged file,
// unacknowledged ⇒ exactly ONE modal, never two in sequence.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SubmitCore,
  type DecisionSummary,
  type ScanOutcome,
  type SubmitCoreDeps,
  type UserDecision,
} from '../src/content/submit/submit-core'
import type { DocGateSnapshot } from '../src/content/submit/document-gate'
import { __resetDocumentGateForTests } from '../src/content/submit/document-gate'
import { openSubmitDecision } from '../src/content/submit/submit-ui'
import {
  __getModalShadowForTests,
  __resetDocumentModalForTests,
} from '../src/content/document-modal'
import { detectDetailed } from '../src/detector/engine'
import { DetectorCategory } from '../src/detector/types'
import type { AlgEvent } from '../src/shared/event-log'
import { FakeSubmitAdapter } from './helpers/fake-submit-adapter'

const SSN_TEXT = 'Patient SSN is 123-45-6789 and please summarise'
const CLEAN_TEXT = 'What is the capital of France? Please be brief.'
const intent = { composerKey: 'chatgpt-composer' }

async function flush(n = 8): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

// A scriptable stand-in for the in-memory document gate. Lets a test
// pin the attach-time file state the send sees, drive a pending→settle
// transition, and observe ack/clear calls.
function makeFakeGate(initial: DocGateSnapshot) {
  let snap = initial
  const waiters: Array<(s: DocGateSnapshot) => void> = []
  const acks: string[] = []
  const clears: string[] = []
  return {
    deps: {
      getDoc: (_k: string): DocGateSnapshot => snap,
      whenDocSettled: (_k: string): Promise<DocGateSnapshot> =>
        snap.status !== 'pending'
          ? Promise.resolve(snap)
          : new Promise<DocGateSnapshot>((res) => waiters.push(res)),
      markDocAcknowledged: (k: string): void => {
        acks.push(k)
      },
      clearDoc: (k: string): void => {
        clears.push(k)
      },
    } satisfies Partial<SubmitCoreDeps>,
    settle(next: DocGateSnapshot): void {
      snap = next
      while (waiters.length) (waiters.shift() as (s: DocGateSnapshot) => void)(next)
    },
    get snap(): DocGateSnapshot {
      return snap
    },
    acks,
    clears,
  }
}

function makeCore(
  gate: ReturnType<typeof makeFakeGate>,
  overrides: Partial<SubmitCoreDeps> = {},
): { core: SubmitCore; logged: AlgEvent[] } {
  const logged: AlgEvent[] = []
  const core = new SubmitCore({
    isEnabled: () => true,
    setTimer: (fn, ms) => setTimeout(fn, ms) as unknown as number,
    clearTimer: (id) => clearTimeout(id),
    logSiteId: 'chatgpt',
    logEvent: (e) => logged.push(e),
    reportAdapterDisabled: () => {},
    scan: (t: string): ScanOutcome => detectDetailed(t),
    ...gate.deps,
    docWaitWatchdogMs: 5000,
    ...overrides,
  })
  return { core, logged }
}

const NONE: DocGateSnapshot = { status: 'none', acknowledged: false }
const CLEAN: DocGateSnapshot = { status: 'clean', acknowledged: false }
const detected = (acknowledged = false, fileCount = 1): DocGateSnapshot => ({
  status: 'detected',
  summary: {
    categories: [DetectorCategory.HEALTHCARE_PATIENT_ID],
    count: 2,
    hasCriticalOrHigh: true,
  },
  fileCount,
  acknowledged,
})
const unable = (acknowledged = false): DocGateSnapshot => ({
  status: 'unable-to-inspect',
  fileCount: 1,
  acknowledged,
})

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  __resetDocumentModalForTests()
  __resetDocumentGateForTests()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('M4 core routing — the §9 Files matrix', () => {
  it('clean text + clean file ⇒ no modal, sends', async () => {
    const gate = makeFakeGate(CLEAN)
    const adapter = new FakeSubmitAdapter({ text: CLEAN_TEXT })
    const decide = vi.fn(async (_s: DecisionSummary) => 'proceed' as UserDecision)
    const { core } = makeCore(gate, { decide })
    const outcome = await core.handleSendIntent(adapter, intent)
    expect(decide).not.toHaveBeenCalled()
    expect(adapter.resumeCalls).toBe(1)
    expect(outcome.submitted).toBe(true)
  })

  it('clean file + sensitive text ⇒ one modal (text only)', async () => {
    const gate = makeFakeGate(CLEAN)
    const adapter = new FakeSubmitAdapter({ text: SSN_TEXT })
    const decide = vi.fn(async (_s: DecisionSummary) => 'proceed' as UserDecision)
    const { core } = makeCore(gate, { decide })
    await core.handleSendIntent(adapter, intent)
    expect(decide).toHaveBeenCalledTimes(1)
    const s = decide.mock.calls[0][0] as DecisionSummary
    expect(s.messageHasSensitiveText).toBe(true)
    expect(s.file).toBeUndefined()
  })

  it('sensitive file + clean text ⇒ one modal (file only), proceed acks + sends', async () => {
    const gate = makeFakeGate(detected())
    const adapter = new FakeSubmitAdapter({ text: CLEAN_TEXT })
    const decide = vi.fn(async (_s: DecisionSummary) => 'proceed' as UserDecision)
    const { core } = makeCore(gate, { decide })
    const outcome = await core.handleSendIntent(adapter, intent)
    expect(decide).toHaveBeenCalledTimes(1)
    const s = decide.mock.calls[0][0] as DecisionSummary
    expect(s.messageHasSensitiveText).toBe(false)
    expect(s.file?.status).toBe('detected')
    expect(outcome.submitted).toBe(true)
    expect(gate.acks).toContain('chatgpt-composer')
  })

  it('sensitive text + sensitive file ⇒ exactly ONE combined modal (blocker §10.6)', async () => {
    const gate = makeFakeGate(detected())
    const adapter = new FakeSubmitAdapter({ text: SSN_TEXT })
    const decide = vi.fn(async (_s: DecisionSummary) => 'proceed' as UserDecision)
    const { core } = makeCore(gate, { decide })
    await core.handleSendIntent(adapter, intent)
    // The single decision governs the whole send — one modal, never two.
    expect(decide).toHaveBeenCalledTimes(1)
    const s = decide.mock.calls[0][0] as DecisionSummary
    expect(s.messageHasSensitiveText).toBe(true)
    expect(s.file?.status).toBe('detected')
    expect(s.file?.fileCount).toBe(1)
  })

  it('file scan pending at send ⇒ holds until settle, no submit before settle', async () => {
    const gate = makeFakeGate({ status: 'pending', acknowledged: false })
    const adapter = new FakeSubmitAdapter({ text: CLEAN_TEXT })
    const { core } = makeCore(gate, { docWaitWatchdogMs: 100000 })
    const p = core.handleSendIntent(adapter, intent)
    await flush()
    expect(adapter.resumeCalls).toBe(0) // held on the pending file
    gate.settle(CLEAN)
    const outcome = await p
    expect(adapter.resumeCalls).toBe(1)
    expect(outcome.submitted).toBe(true)
  })

  it('file scan pending exceeds watchdog ⇒ fail open: sends + logs unable-to-inspect, no hang', async () => {
    const gate = makeFakeGate({ status: 'pending', acknowledged: false })
    const adapter = new FakeSubmitAdapter({ text: CLEAN_TEXT })
    const { core, logged } = makeCore(gate, { docWaitWatchdogMs: 1000 })
    const p = core.handleSendIntent(adapter, intent)
    await flush()
    expect(adapter.resumeCalls).toBe(0)
    await vi.advanceTimersByTimeAsync(1000) // fire the doc-wait watchdog
    const outcome = await p
    expect(outcome.failedOpen).toBe(true)
    expect(outcome.submitted).toBe(true)
    expect(adapter.resumeCalls).toBe(1)
    expect(logged.some((e) => e.action === 'unable-to-inspect')).toBe(true)
  })

  it('unable-to-inspect file + clean text ⇒ modal; proceed sends once', async () => {
    const gate = makeFakeGate(unable())
    const adapter = new FakeSubmitAdapter({ text: CLEAN_TEXT })
    const decide = vi.fn(async (_s: DecisionSummary) => 'proceed' as UserDecision)
    const { core } = makeCore(gate, { decide })
    const outcome = await core.handleSendIntent(adapter, intent)
    expect(decide).toHaveBeenCalledTimes(1)
    expect((decide.mock.calls[0][0] as DecisionSummary).file?.status).toBe('unable-to-inspect')
    expect(adapter.resumeCalls).toBe(1)
    expect(outcome.submitted).toBe(true)
  })

  it('unable-to-inspect file + clean text ⇒ return-to-edit sends nothing, gate untouched (attachment preserved)', async () => {
    const gate = makeFakeGate(unable())
    const adapter = new FakeSubmitAdapter({ text: CLEAN_TEXT })
    const decide = vi.fn(async (_s: DecisionSummary) => 'return-to-edit' as UserDecision)
    const { core } = makeCore(gate, { decide })
    const outcome = await core.handleSendIntent(adapter, intent)
    expect(adapter.resumeCalls).toBe(0)
    expect(outcome.submitted).toBe(false)
    expect(outcome.state).toBe('RETURNED_TO_EDIT')
    // The file was never released or cleared — its gate state survives.
    expect(gate.clears).not.toContain('chatgpt-composer')
    expect(gate.snap.status).toBe('unable-to-inspect')
  })

  it('acknowledged detected file + clean text ⇒ no re-warn (dedup), sends', async () => {
    const gate = makeFakeGate(detected(/* acknowledged */ true))
    const adapter = new FakeSubmitAdapter({ text: CLEAN_TEXT })
    const decide = vi.fn(async (_s: DecisionSummary) => 'proceed' as UserDecision)
    const { core } = makeCore(gate, { decide })
    const outcome = await core.handleSendIntent(adapter, intent)
    expect(decide).not.toHaveBeenCalled()
    expect(outcome.submitted).toBe(true)
  })

  it('multiple files, ≥1 detected ⇒ one combined modal, fileCount reflects count', async () => {
    const gate = makeFakeGate(detected(false, 3))
    const adapter = new FakeSubmitAdapter({ text: SSN_TEXT })
    const decide = vi.fn(async (_s: DecisionSummary) => 'proceed' as UserDecision)
    const { core } = makeCore(gate, { decide })
    await core.handleSendIntent(adapter, intent)
    expect(decide).toHaveBeenCalledTimes(1)
    expect((decide.mock.calls[0][0] as DecisionSummary).file?.fileCount).toBe(3)
  })

  it('confirmed send clears the doc gate (next message re-evaluates)', async () => {
    const gate = makeFakeGate(detected())
    const adapter = new FakeSubmitAdapter({ text: SSN_TEXT })
    const decide = vi.fn(async (_s: DecisionSummary) => 'proceed' as UserDecision)
    const { core } = makeCore(gate, { decide })
    await core.handleSendIntent(adapter, intent)
    expect(gate.clears).toContain('chatgpt-composer')
  })

  it('no attached file (none) + clean text ⇒ sends, gate never consulted for a decision', async () => {
    const gate = makeFakeGate(NONE)
    const adapter = new FakeSubmitAdapter({ text: CLEAN_TEXT })
    const decide = vi.fn(async (_s: DecisionSummary) => 'proceed' as UserDecision)
    const { core } = makeCore(gate, { decide })
    const outcome = await core.handleSendIntent(adapter, intent)
    expect(decide).not.toHaveBeenCalled()
    expect(outcome.submitted).toBe(true)
  })
})

describe('M4 combined modal render (jsdom, one modal)', () => {
  const headingText = (): string => {
    const shadow = __getModalShadowForTests()
    return shadow?.querySelector('.heading')?.textContent ?? ''
  }
  const hostCount = (): number =>
    document.querySelectorAll('[data-ai-leak-guard-document-modal]').length

  it('text + file ⇒ ONE modal, merged heading + summed count', async () => {
    const summary: DecisionSummary = {
      composerKey: 'chatgpt-composer',
      fingerprint: 'government_financial:2',
      count: 2,
      categories: [DetectorCategory.GOVERNMENT_FINANCIAL],
      hadCriticalOrHigh: true,
      changedSinceAcknowledged: false,
      messageHasSensitiveText: true,
      file: {
        status: 'detected',
        fileCount: 1,
        categories: [DetectorCategory.HEALTHCARE_PATIENT_ID],
        count: 3,
        hasCriticalOrHigh: true,
      },
    }
    const p = openSubmitDecision(summary, null)
    expect(hostCount()).toBe(1)
    const h = headingText()
    expect(h).toContain('message and its attachment')
    expect(h).toContain('5') // 2 text + 3 file
    __resetDocumentModalForTests() // resolves the outcome (cancel)
    await expect(p).resolves.toBe('return-to-edit')
  })

  it('file-only detected ⇒ attachment-focused heading, one modal', async () => {
    const summary: DecisionSummary = {
      composerKey: 'chatgpt-composer',
      fingerprint: 'none',
      count: 0,
      categories: [],
      hadCriticalOrHigh: false,
      changedSinceAcknowledged: false,
      messageHasSensitiveText: false,
      file: {
        status: 'detected',
        fileCount: 1,
        categories: [DetectorCategory.HEALTHCARE_PATIENT_ID],
        count: 3,
        hasCriticalOrHigh: true,
      },
    }
    const p = openSubmitDecision(summary, null)
    expect(hostCount()).toBe(1)
    const h = headingText()
    expect(h).toContain('this attachment')
    expect(h).not.toContain('message and its attachment')
    __resetDocumentModalForTests()
    await p
  })

  it('file-only unable + clean text ⇒ honest "couldn’t read" view, one modal', async () => {
    const summary: DecisionSummary = {
      composerKey: 'chatgpt-composer',
      fingerprint: 'none',
      count: 0,
      categories: [],
      hadCriticalOrHigh: false,
      changedSinceAcknowledged: false,
      messageHasSensitiveText: false,
      file: {
        status: 'unable-to-inspect',
        fileCount: 1,
        categories: [],
        count: 0,
        hasCriticalOrHigh: false,
      },
    }
    const p = openSubmitDecision(summary, null)
    expect(hostCount()).toBe(1)
    expect(headingText().toLowerCase()).toContain("couldn't read")
    __resetDocumentModalForTests()
    await p
  })

  it('text + unable file ⇒ sensitive view carries the "couldn’t inspect" note', async () => {
    const summary: DecisionSummary = {
      composerKey: 'chatgpt-composer',
      fingerprint: 'government_financial:1',
      count: 1,
      categories: [DetectorCategory.GOVERNMENT_FINANCIAL],
      hadCriticalOrHigh: true,
      changedSinceAcknowledged: false,
      messageHasSensitiveText: true,
      file: {
        status: 'unable-to-inspect',
        fileCount: 1,
        categories: [],
        count: 0,
        hasCriticalOrHigh: false,
      },
    }
    const p = openSubmitDecision(summary, null)
    expect(hostCount()).toBe(1)
    const shadow = __getModalShadowForTests()
    const body = shadow?.querySelector('.body')?.textContent ?? ''
    expect(body.toLowerCase()).toContain('couldn’t be inspected'.toLowerCase())
    __resetDocumentModalForTests()
    await p
  })
})
