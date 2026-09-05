// @vitest-environment jsdom
//
// V1.3 M5 — the HEADLINE safety test: run the self-test against the REAL
// ChatGPT submit adapter + core + warning modal, and prove it (1) makes
// the real interception fire and the real modal appear, (2) NEVER calls
// resume() / submits, and (3) NEVER overwrites an existing draft.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatGptSubmitAdapter } from '../src/content/submit/adapters/chatgpt'
import { SubmitCore } from '../src/content/submit/submit-core'
import { openSubmitDecision } from '../src/content/submit/submit-ui'
import { isDocumentModalOpen, __resetDocumentModalForTests } from '../src/content/document-modal'
import { __resetDocumentGateForTests } from '../src/content/submit/document-gate'
import { runSelfTest, type SelfTestRunnerDeps } from '../src/content/submit/self-test'
import { SYNTHETIC_TEXT } from '../src/shared/self-test'

function build(): { composer: HTMLElement; button: HTMLButtonElement } {
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
  return { composer, button }
}

let adapter: ChatGptSubmitAdapter | null = null

afterEach(() => {
  adapter?.detach()
  adapter = null
  __resetDocumentModalForTests()
  __resetDocumentGateForTests()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

// Real-DOM deps wiring the runner to the live adapter/modal.
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

describe('self-test integration (real adapter + core + modal)', () => {
  it('confirmed: real interception + modal, resume NEVER called, composer left clean', async () => {
    const { composer } = build()
    adapter = new ChatGptSubmitAdapter()
    const resumeSpy = vi.spyOn(adapter, 'resume')
    const core = new SubmitCore({
      isEnabled: () => true,
      logSiteId: '',
      decide: (summary) => openSubmitDecision(summary, null),
    })
    adapter.attach(core)

    const report = await runSelfTest(realDeps(adapter))

    expect(report.result).toBe('confirmed')
    expect(report.intercept).toBe(1)
    expect(report.modal).toBe(1)
    // THE safety assertion: the send was never resumed.
    expect(resumeSpy).not.toHaveBeenCalled()
    // Synthetic text cleared; nothing left in the composer.
    expect(composer.textContent?.trim()).toBe('')
    // Modal is gone (cancelled).
    expect(isDocumentModalOpen()).toBe(false)
  })

  it('never overwrites an existing draft: pre-filled composer → DRAFT_PRESENT, untouched, no send', async () => {
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

    const report = await runSelfTest(realDeps(adapter))

    expect(report.result).toBe('fail')
    expect(report.code).toBe('DRAFT_PRESENT')
    // The user's draft is byte-for-byte intact, and NOTHING synthetic
    // was inserted or sent.
    expect(composer.textContent).toContain('My real question about patient care planning')
    expect(composer.textContent).not.toContain(SYNTHETIC_TEXT)
    expect(resumeSpy).not.toHaveBeenCalled()
    expect(isDocumentModalOpen()).toBe(false)
  })
})
