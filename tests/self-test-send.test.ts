// @vitest-environment jsdom
//
// V1.3.3 — THE load-bearing safety test: the self-test cannot submit synthetic
// PHI to the provider even when interception fails. `dispatchSelfTestSend`
// installs a capture-phase safety net so the synthetic Enter can never reach a
// site send handler. We prove it against a real site-send sink, with and
// without the ALG adapter, and include a control showing the danger is real
// (a raw Enter, with no net, DOES reach the sink).

import { afterEach, describe, expect, it, vi } from 'vitest'
import { dispatchSelfTestSend } from '../src/content/submit/self-test-send'
import { ChatGptSubmitAdapter } from '../src/content/submit/adapters/chatgpt'
import { SubmitCore } from '../src/content/submit/submit-core'
import { openSubmitDecision } from '../src/content/submit/submit-ui'
import { isDocumentModalOpen, __resetDocumentModalForTests } from '../src/content/document-modal'
import { __resetDocumentGateForTests } from '../src/content/submit/document-gate'

function composer(): HTMLElement {
  document.body.innerHTML = ''
  const el = document.createElement('div')
  el.id = 'prompt-textarea'
  el.setAttribute('contenteditable', 'true')
  el.setAttribute('role', 'textbox')
  el.innerHTML = '<p>Patient SSN is 123-45-6789</p>'
  document.body.append(el)
  return el
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

describe('self-test send safety net', () => {
  it('CONTROL: a raw Enter with no net and no adapter DOES reach the site — the danger is real', () => {
    const el = composer()
    const siteSend = vi.fn()
    document.addEventListener('keydown', siteSend) // models the site's send-on-Enter
    try {
      el.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      )
      expect(siteSend).toHaveBeenCalledTimes(1)
    } finally {
      document.removeEventListener('keydown', siteSend)
    }
  })

  it('FAILING interceptor: no adapter → the synthetic text is NOT submitted (net blocks it)', () => {
    const el = composer()
    const siteSend = vi.fn() // the provider's send handler
    document.addEventListener('keydown', siteSend)
    try {
      const result = dispatchSelfTestSend(el)
      // The load-bearing assertion: nothing went to the provider.
      expect(siteSend).not.toHaveBeenCalled()
      // And it is correctly reported as NOT intercepted (protection inactive),
      // caught by the safety net rather than the adapter.
      expect(result.intercepted).toBe(false)
      expect(result.blockedBySafetyNet).toBe(true)
    } finally {
      document.removeEventListener('keydown', siteSend)
    }
  })

  it('WORKING interceptor: adapter takes the send → intercepted, still nothing submitted, modal shown', async () => {
    const el = composer()
    const siteSend = vi.fn()
    document.addEventListener('keydown', siteSend)
    adapter = new ChatGptSubmitAdapter()
    const core = new SubmitCore({
      isEnabled: () => true,
      logSiteId: '',
      decide: (summary) => openSubmitDecision(summary, null),
    })
    adapter.attach(core)
    try {
      const result = dispatchSelfTestSend(el)
      expect(result.intercepted).toBe(true)
      expect(result.blockedBySafetyNet).toBe(false)
      // The adapter blocked the native send too — never reaches the provider.
      expect(siteSend).not.toHaveBeenCalled()
      // Real interception opens the warning modal (async: the core scans +
      // decides in a microtask, then paints).
      for (let i = 0; i < 50 && !isDocumentModalOpen(); i += 1) {
        await new Promise((r) => setTimeout(r, 5))
      }
      expect(isDocumentModalOpen()).toBe(true)
    } finally {
      document.removeEventListener('keydown', siteSend)
    }
  })
})
