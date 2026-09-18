// @vitest-environment jsdom
//
// V1.3.4 — the `#alg-selftest` hash path drives the SAME guided self-test the
// popup does, with every safety intact. This wires the hash trigger's injected
// `run` to the REAL ChatGPT adapter + core + warning modal (exactly as the
// content script does) and proves, through the hash entry point:
//   • empty composer  → the real interception + modal fire, resume NEVER called,
//                        the synthetic text is cleared, a banner shows, and the
//                        `#alg-selftest` token is stripped from the URL.
//   • non-empty draft → bails DRAFT_PRESENT, the user's text is byte-for-byte
//                        intact, nothing synthetic is inserted or sent.
//   • the run-once guard means a repeated hashchange never re-runs it.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatGptSubmitAdapter } from '../src/content/submit/adapters/chatgpt'
import { SubmitCore } from '../src/content/submit/submit-core'
import { openSubmitDecision } from '../src/content/submit/submit-ui'
import { isDocumentModalOpen, __resetDocumentModalForTests } from '../src/content/document-modal'
import { __resetDocumentGateForTests } from '../src/content/submit/document-gate'
import { runSelfTest, type SelfTestRunnerDeps } from '../src/content/submit/self-test'
import {
  showSelfTestBanner,
  __resetSelfTestBannerForTests,
} from '../src/content/submit/self-test-banner'
import { createHashSelfTestTrigger } from '../src/content/submit/self-test-hash'
import { SELF_TEST_CASES } from '../src/shared/self-test'

const BANNER = '[data-ai-leak-guard-selftest-banner]'

function build(): { composer: HTMLElement } {
  document.body.innerHTML = ''
  const composer = document.createElement('div')
  composer.id = 'prompt-textarea'
  composer.setAttribute('contenteditable', 'true')
  composer.setAttribute('role', 'textbox')
  composer.innerHTML = '<p></p>'
  const button = document.createElement('button')
  button.setAttribute('data-testid', 'send-button')
  button.setAttribute('aria-label', 'Send prompt')
  document.body.append(composer, button)
  return { composer }
}

let adapter: ChatGptSubmitAdapter | null = null

afterEach(() => {
  adapter?.detach()
  adapter = null
  __resetDocumentModalForTests()
  __resetDocumentGateForTests()
  __resetSelfTestBannerForTests()
  document.body.innerHTML = ''
  // Reset the URL hash between tests.
  history.replaceState(null, '', location.pathname + location.search)
  vi.restoreAllMocks()
})

function realDeps(submitAdapter: ChatGptSubmitAdapter): SelfTestRunnerDeps {
  return {
    getComposer: () => submitAdapter.resolveComposer(),
    readText: (el) => el.textContent ?? '',
    insert: (el, text) => {
      el.innerHTML = `<p>${text}</p>`
    },
    clear: (el) => {
      el.innerHTML = '<p></p>'
    },
    dispatchSend: (el) => {
      el.focus?.()
      const ev = new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        bubbles: true,
        cancelable: true,
        composed: true,
      })
      el.dispatchEvent(ev)
      return ev.defaultPrevented
    },
    isModalOpen: () => isDocumentModalOpen(),
    cancelModal: () => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
          composed: true,
        }),
      )
    },
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    composerTimeoutMs: 1000,
    modalTimeoutMs: 2000,
    pollMs: 5,
  }
}

/**
 * Reproduce the content script's hash wiring: a run-once trigger whose injected
 * `run` drives the real runner and then shows the in-tab banner. `runResolved`
 * lets the tests await the async run the module normally fires-and-forgets.
 */
function wireHashTrigger(a: ChatGptSubmitAdapter): {
  check: () => void
  runResolved: () => Promise<void>
  report: () => Awaited<ReturnType<typeof runSelfTest>> | null
} {
  let report: Awaited<ReturnType<typeof runSelfTest>> | null = null
  let pending: Promise<void> = Promise.resolve()
  const trigger = createHashSelfTestTrigger({
    getHash: () => location.hash,
    stripHash: () => {
      history.replaceState(null, '', location.pathname + location.search)
    },
    run: () => {
      pending = (async () => {
        report = await runSelfTest(realDeps(a))
        showSelfTestBanner(
          { result: report.result, code: report.code },
          { onReport: () => {}, autoDismissMs: 0 },
        )
      })()
    },
    isTopFrame: () => true,
  })
  return { check: () => trigger.check(), runResolved: () => pending, report: () => report }
}

describe('#alg-selftest hash path (real adapter + core + modal)', () => {
  it('empty composer: drives the real self-test, shows a banner, strips the hash, never resumes', async () => {
    const { composer } = build()
    adapter = new ChatGptSubmitAdapter()
    const resumeSpy = vi.spyOn(adapter, 'resume')
    const core = new SubmitCore({
      isEnabled: () => true,
      logSiteId: '',
      decide: (summary) => openSubmitDecision(summary, null),
    })
    adapter.attach(core)

    location.hash = '#alg-selftest'
    const w = wireHashTrigger(adapter)
    w.check()
    await w.runResolved()

    // The hash entry point drove the SAME runner the popup uses.
    expect(w.report()?.result).toBe('confirmed')
    expect(w.report()?.intercept).toBe(1)
    expect(w.report()?.modal).toBe(1)
    // Safety: never submitted.
    expect(resumeSpy).not.toHaveBeenCalled()
    // Synthetic text cleared; modal cancelled.
    expect(composer.textContent?.trim()).toBe('')
    expect(isDocumentModalOpen()).toBe(false)
    // The in-tab banner is the outcome surface (no popup is waiting).
    expect(document.querySelectorAll(BANNER).length).toBe(1)
    // The token is consumed from the URL.
    expect(location.hash).toBe('')
  })

  it('non-empty composer: bails DRAFT_PRESENT, the user text is untouched, nothing sent', async () => {
    const { composer } = build()
    composer.innerHTML = '<p>My real question about patient care planning</p>'
    adapter = new ChatGptSubmitAdapter()
    const resumeSpy = vi.spyOn(adapter, 'resume')
    const core = new SubmitCore({
      isEnabled: () => true,
      logSiteId: '',
      decide: (summary) => openSubmitDecision(summary, null),
    })
    adapter.attach(core)

    location.hash = '#alg-selftest'
    const w = wireHashTrigger(adapter)
    w.check()
    await w.runResolved()

    expect(w.report()?.result).toBe('fail')
    expect(w.report()?.code).toBe('DRAFT_PRESENT')
    // The user's own draft is byte-for-byte intact and NOTHING synthetic was
    // inserted or sent.
    expect(composer.textContent).toContain('My real question about patient care planning')
    for (const c of SELF_TEST_CASES) expect(composer.textContent).not.toContain(c.text)
    expect(resumeSpy).not.toHaveBeenCalled()
    expect(isDocumentModalOpen()).toBe(false)
    // The hash is still consumed even when the run bails.
    expect(location.hash).toBe('')
  })

  it('run-once: a second hashchange after the run does not start it again', async () => {
    build()
    adapter = new ChatGptSubmitAdapter()
    const core = new SubmitCore({
      isEnabled: () => true,
      logSiteId: '',
      decide: (summary) => openSubmitDecision(summary, null),
    })
    adapter.attach(core)

    const runSpy = vi.fn()
    const trigger = createHashSelfTestTrigger({
      getHash: () => location.hash,
      stripHash: () => {
        history.replaceState(null, '', location.pathname + location.search)
      },
      run: runSpy,
      isTopFrame: () => true,
    })

    location.hash = '#alg-selftest'
    trigger.check() // initial load → runs once, strips the token
    expect(location.hash).toBe('')
    // Simulate an SPA re-navigating back to the token and firing hashchange.
    location.hash = '#alg-selftest'
    trigger.check()
    trigger.check()

    // Still exactly one run, and once consumed the trigger leaves the re-set
    // hash alone (it no longer touches the URL).
    expect(runSpy).toHaveBeenCalledTimes(1)
    expect(location.hash).toBe('#alg-selftest')
  })
})
