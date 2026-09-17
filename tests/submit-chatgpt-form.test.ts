// @vitest-environment jsdom
//
// V1.3.3 RELEASE BLOCKER — logged-out chatgpt.com renders the composer as a
// plain <textarea id="mobile-composer-prompt" name="prompt"> inside a <form>
// with a type=submit send button. The send is a FORM SUBMISSION, which the
// contenteditable + Enter/button model didn't cover, so paste and send were
// both unprotected. These tests pin the fix: the form submit / button / Enter
// paths are HELD (scanned, not sent) and only released on the user's decision.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatGptSubmitAdapter } from '../src/content/submit/adapters/chatgpt'
import {
  SubmitCore,
  type ScanOutcome,
  type SubmitCoreDeps,
} from '../src/content/submit/submit-core'
import { detectDetailed } from '../src/detector/engine'
import { __resetDocumentModalForTests } from '../src/content/document-modal'

const SSN_TEXT = 'Patient SSN is 123-45-6789'
const CLEAN_TEXT = 'What is the capital of France?'

interface FormHarness {
  form: HTMLFormElement
  textarea: HTMLTextAreaElement
  button: HTMLButtonElement | null
  siteSends: () => number
}

function buildForm(opts: { withButton?: boolean; buttonDisabled?: boolean } = {}): FormHarness {
  document.body.innerHTML = ''
  const form = document.createElement('form')
  const textarea = document.createElement('textarea')
  textarea.id = 'mobile-composer-prompt'
  textarea.name = 'prompt'
  textarea.setAttribute('placeholder', 'Ask ChatGPT')
  form.appendChild(textarea)
  let button: HTMLButtonElement | null = null
  if (opts.withButton !== false) {
    button = document.createElement('button')
    button.type = 'submit'
    button.setAttribute('aria-label', 'Send message')
    if (opts.buttonDisabled === true) button.disabled = true
    form.appendChild(button)
  }
  document.body.appendChild(form)

  // The SITE's send: a form submit listener. If the adapter holds the send
  // (capture + stopImmediatePropagation), this never runs. preventDefault only
  // to stop jsdom's "navigation not implemented" noise on a real submission.
  let sends = 0
  form.addEventListener('submit', (e) => {
    sends += 1
    e.preventDefault()
  })
  return { form, textarea, button, siteSends: () => sends }
}

function makeCore(overrides: Partial<SubmitCoreDeps> = {}): SubmitCore {
  return new SubmitCore({
    isEnabled: () => true,
    setTimer: (fn, ms) => setTimeout(fn, ms) as unknown as number,
    clearTimer: (id) => clearTimeout(id),
    logSiteId: '',
    logEvent: () => {},
    reportAdapterDisabled: () => {},
    ...overrides,
  })
}

function heldDecide() {
  // A decision seam that stays open (the send is held) until we resolve it.
  const h = {
    calls: 0,
    resolve: (_d: 'proceed' | 'return-to-edit') => {},
    decide: (): Promise<'proceed' | 'return-to-edit'> =>
      new Promise((res) => {
        h.calls += 1
        h.resolve = res
      }),
  }
  return h
}

async function flush(n = 8): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

let adapter: ChatGptSubmitAdapter | null = null

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  adapter?.detach()
  adapter = null
  document.body.innerHTML = ''
  __resetDocumentModalForTests()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('logged-out ChatGPT form composer — send is HELD, not sent', () => {
  it('a form submit of flagged text is intercepted (held) and NOT submitted', async () => {
    const h = buildForm()
    h.textarea.value = SSN_TEXT
    const scan = vi.fn((t: string): ScanOutcome => detectDetailed(t))
    const decide = heldDecide()
    adapter = new ChatGptSubmitAdapter()
    adapter.attach(makeCore({ scan, decide: decide.decide }))

    // Simulate the form submitting (Enter → requestSubmit or the submit button).
    const event = new Event('submit', { bubbles: true, cancelable: true })
    h.form.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true) // native submission cancelled
    await flush()
    expect(scan).toHaveBeenCalledTimes(1)
    expect(scan).toHaveBeenCalledWith(SSN_TEXT)
    expect(decide.calls).toBe(1) // the warning is up
    expect(h.siteSends()).toBe(0) // and nothing reached the provider
  })

  it('the submit-button click (type=submit, "Send message") is held', async () => {
    const h = buildForm()
    h.textarea.value = SSN_TEXT
    const scan = vi.fn((t: string): ScanOutcome => detectDetailed(t))
    const decide = heldDecide()
    adapter = new ChatGptSubmitAdapter()
    adapter.attach(makeCore({ scan, decide: decide.decide }))

    const event = new MouseEvent('click', { bubbles: true, cancelable: true })
    h.button!.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
    await flush()
    expect(scan).toHaveBeenCalledTimes(1)
    expect(h.siteSends()).toBe(0)
  })

  it('plain Enter in the textarea is held; Shift+Enter is a newline (not held)', async () => {
    const h = buildForm()
    h.textarea.value = SSN_TEXT
    const scan = vi.fn((t: string): ScanOutcome => detectDetailed(t))
    adapter = new ChatGptSubmitAdapter()
    adapter.attach(makeCore({ scan, decide: heldDecide().decide }))

    const enter = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
      composed: true,
    })
    h.textarea.focus()
    h.textarea.dispatchEvent(enter)
    expect(enter.defaultPrevented).toBe(true)
    await flush()
    expect(scan).toHaveBeenCalledTimes(1)

    const shiftEnter = new KeyboardEvent('keydown', {
      key: 'Enter',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
      composed: true,
    })
    h.textarea.dispatchEvent(shiftEnter)
    expect(shiftEnter.defaultPrevented).toBe(false) // newline preserved
  })

  it('CLEAN text form submit is NOT held — the send proceeds', async () => {
    const h = buildForm()
    h.textarea.value = CLEAN_TEXT
    const scan = vi.fn((t: string): ScanOutcome => detectDetailed(t))
    adapter = new ChatGptSubmitAdapter()
    adapter.attach(makeCore({ scan, decide: heldDecide().decide }))

    const event = new Event('submit', { bubbles: true, cancelable: true })
    h.form.dispatchEvent(event)
    await flush()
    // Clean text: the core does not hold — the native submission is untouched
    // (defaultPrevented may be set briefly then released, so assert the site
    // send actually happened and no decision was requested).
    expect(h.siteSends()).toBe(1)
  })

  it('on PROCEED the held form is re-submitted exactly once (resume)', async () => {
    // No usable button → resume takes the form.requestSubmit() path.
    const h = buildForm({ withButton: false })
    h.textarea.value = SSN_TEXT
    const requestSubmit = vi.fn(() => {
      // Model the native re-submit: fires the site's submit listener.
      h.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    // jsdom may not implement requestSubmit — install our spy either way.
    ;(h.form as unknown as { requestSubmit: () => void }).requestSubmit = requestSubmit

    const scan = vi.fn((t: string): ScanOutcome => detectDetailed(t))
    const decide = heldDecide()
    adapter = new ChatGptSubmitAdapter()
    adapter.attach(makeCore({ scan, decide: decide.decide }))

    const event = new Event('submit', { bubbles: true, cancelable: true })
    h.form.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    await flush()
    expect(h.siteSends()).toBe(0) // held — not yet sent

    // The user proceeds.
    decide.resolve('proceed')
    await flush()

    expect(requestSubmit).toHaveBeenCalledTimes(1) // resumed via form re-submit
    expect(h.siteSends()).toBe(1) // exactly one submission
  })
})
