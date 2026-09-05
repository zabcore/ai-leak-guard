// @vitest-environment jsdom
//
// V1.3 M5 — the self-test RUNNER (`runSelfTest`) drives the real path on
// synthetic data and ALWAYS cancels. These pin its safety contracts with
// injected DOM seams: it never overwrites a draft, never has any way to
// submit (no resume seam exists), clears the synthetic text on every
// exit, and only ever CANCELS the modal.

import { describe, expect, it, vi } from 'vitest'
import { runSelfTest, type SelfTestRunnerDeps } from '../src/content/submit/self-test'
import { SYNTHETIC_TEXT } from '../src/shared/self-test'

function baseDeps(overrides: Partial<SelfTestRunnerDeps> = {}): {
  deps: SelfTestRunnerDeps
  el: HTMLElement
  calls: {
    insert: string[]
    cleared: number
    cancelled: number
    dispatched: number
  }
} {
  const el = document.createElement('div')
  const calls = { insert: [] as string[], cleared: 0, cancelled: 0, dispatched: 0 }
  let text = ''
  let modalOpen = false
  const deps: SelfTestRunnerDeps = {
    getComposer: () => el,
    readText: () => text,
    insert: (_e, t) => {
      calls.insert.push(t)
      text = t
    },
    clear: () => {
      calls.cleared += 1
      text = ''
    },
    dispatchSend: () => {
      calls.dispatched += 1
      // Interception fires; the modal opens shortly after.
      modalOpen = true
      return true
    },
    isModalOpen: () => modalOpen,
    cancelModal: () => {
      calls.cancelled += 1
      modalOpen = false
    },
    now: () => Date.now(),
    sleep: () => Promise.resolve(),
    composerTimeoutMs: 100,
    modalTimeoutMs: 100,
    pollMs: 1,
    ...overrides,
  }
  return { deps, el, calls }
}

describe('runSelfTest', () => {
  it('success: synthetic → intercept → modal → auto-cancel → confirmed, cleared, never overwrites/submits', async () => {
    const { deps, calls } = baseDeps()
    const report = await runSelfTest(deps)
    expect(report).toEqual({ result: 'confirmed', code: 'OK', composer: 1, intercept: 1, modal: 1 })
    // Inserted exactly the synthetic text, then cleared it.
    expect(calls.insert).toEqual([SYNTHETIC_TEXT])
    expect(calls.cleared).toBeGreaterThanOrEqual(1)
    // The ONLY modal interaction was a cancel — there is no resume seam.
    expect(calls.cancelled).toBe(1)
    expect('resume' in deps).toBe(false)
    expect('proceed' in deps).toBe(false)
  })

  it('NO_COMPOSER: composer never resolves → fail, nothing inserted', async () => {
    const { deps, calls } = baseDeps({ getComposer: () => null })
    const report = await runSelfTest(deps)
    expect(report.result).toBe('fail')
    expect(report.code).toBe('NO_COMPOSER')
    expect(calls.insert).toEqual([])
    expect(calls.dispatched).toBe(0)
  })

  it('DRAFT_PRESENT: refuses to run over an existing draft (never overwrites)', async () => {
    const { deps, calls } = baseDeps({ readText: () => 'the user was typing something real' })
    const report = await runSelfTest(deps)
    expect(report.result).toBe('fail')
    expect(report.code).toBe('DRAFT_PRESENT')
    expect(report.composer).toBe(1)
    // Never inserted synthetic text, never cleared the user's draft.
    expect(calls.insert).toEqual([])
    expect(calls.cleared).toBe(0)
    expect(calls.dispatched).toBe(0)
  })

  it('NO_INTERCEPT: send not taken → unsupported, synthetic text cleared', async () => {
    const { deps, calls } = baseDeps({ dispatchSend: () => false })
    const report = await runSelfTest(deps)
    expect(report.result).toBe('unsupported')
    expect(report.code).toBe('NO_INTERCEPT')
    expect(calls.cleared).toBeGreaterThanOrEqual(1)
    expect(calls.cancelled).toBe(0)
  })

  it('NO_MODAL: interception fired but modal never appears → fail, cleared, never cancels', async () => {
    const { deps, calls } = baseDeps({
      dispatchSend: () => true, // intercepts, but…
      isModalOpen: () => false, // …modal never shows
    })
    const report = await runSelfTest(deps)
    expect(report.result).toBe('fail')
    expect(report.code).toBe('NO_MODAL')
    expect(report.intercept).toBe(1)
    expect(report.modal).toBe(0)
    expect(calls.cleared).toBeGreaterThanOrEqual(1)
    expect(calls.cancelled).toBe(0)
  })

  it('never submits: no seam can proceed; the success path only cancels', async () => {
    // Belt-and-suspenders: even if we hand the runner a "resume"-shaped
    // fake, it is never referenced — the type has no such member and the
    // runner only calls cancelModal.
    const resume = vi.fn()
    const { deps, calls } = baseDeps()
    await runSelfTest({ ...deps, ...({ resume } as unknown as object) } as SelfTestRunnerDeps)
    expect(resume).not.toHaveBeenCalled()
    expect(calls.cancelled).toBe(1)
  })
})
