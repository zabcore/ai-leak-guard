// @vitest-environment jsdom
//
// V1.3 M3 — Claude (claude.ai) submit-scan adapter tests. Mirrors the
// ChatGPT suite; all behaviour is inherited from `BaseSubmitAdapter`,
// so these pin the CLAUDE CONFIG (selectors, composer key) drives the
// same behaviour, plus the site-agnostic guarantees on Claude's DOM.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ClaudeSubmitAdapter } from '../src/content/submit/adapters/claude'
import { detectDetailed } from '../src/detector/engine'
import { __resetDocumentModalForTests } from '../src/content/document-modal'
import {
  controllableDecide,
  makeCore,
  pressEnter,
  flush,
  SSN_TEXT,
  CLEAN_TEXT,
  type Harness,
  type ScanOutcome,
} from './helpers/submit-adapter-harness'

// Claude composer: ProseMirror contenteditable [role=textbox]. Send
// button: data-testid="chat-input-send" (+ aria-label="Send message").
function buildClaude(opts: { buttonDisabled?: boolean } = {}): Harness {
  document.body.innerHTML = ''
  const composer = document.createElement('div')
  composer.setAttribute('contenteditable', 'true')
  composer.setAttribute('role', 'textbox')
  composer.innerHTML = '<p></p>'
  const button = document.createElement('button')
  button.setAttribute('data-testid', 'chat-input-send')
  button.setAttribute('aria-label', 'Send message')
  if (opts.buttonDisabled) button.disabled = true
  document.body.append(composer, button)
  return {
    composer,
    button,
    setComposerHtml: (html) => {
      composer.innerHTML = html
    },
    cleanup: () => {
      document.body.innerHTML = ''
    },
  }
}

let harness: Harness | null = null
let adapter: ClaudeSubmitAdapter | null = null

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  adapter?.detach()
  adapter = null
  harness?.cleanup()
  harness = null
  __resetDocumentModalForTests()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('Claude — send-intent detection', () => {
  it('Enter → intent → preventDefault + scan', async () => {
    harness = buildClaude()
    harness.setComposerHtml('<p>hello world this is plenty long</p>')
    const scan = vi.fn((t: string): ScanOutcome => detectDetailed(t))
    adapter = new ClaudeSubmitAdapter()
    adapter.attach(makeCore({ scan }))
    const event = pressEnter(harness.composer)
    expect(event.defaultPrevented).toBe(true)
    await flush()
    expect(scan).toHaveBeenCalledTimes(1)
  })

  it('Shift+Enter → newline, no intent', async () => {
    harness = buildClaude()
    harness.setComposerHtml('<p>hello world this is plenty long</p>')
    const scan = vi.fn((t: string): ScanOutcome => detectDetailed(t))
    adapter = new ClaudeSubmitAdapter()
    adapter.attach(makeCore({ scan }))
    const event = pressEnter(harness.composer, { shiftKey: true })
    expect(event.defaultPrevented).toBe(false)
    await flush()
    expect(scan).not.toHaveBeenCalled()
  })

  it('IME composing Enter (isComposing) → never intercepted', async () => {
    harness = buildClaude()
    harness.setComposerHtml('<p>コンポジション</p>')
    const scan = vi.fn((t: string): ScanOutcome => detectDetailed(t))
    adapter = new ClaudeSubmitAdapter()
    adapter.attach(makeCore({ scan }))
    const event = pressEnter(harness.composer, { isComposing: true })
    expect(event.defaultPrevented).toBe(false)
    await flush()
    expect(scan).not.toHaveBeenCalled()
  })

  it('IME confirm Enter (keyCode 229) → never intercepted', async () => {
    harness = buildClaude()
    harness.setComposerHtml('<p>入力</p>')
    const scan = vi.fn((t: string): ScanOutcome => detectDetailed(t))
    adapter = new ClaudeSubmitAdapter()
    adapter.attach(makeCore({ scan }))
    const event = pressEnter(harness.composer, { keyCode: 229 })
    expect(event.keyCode).toBe(229)
    expect(event.defaultPrevented).toBe(false)
    await flush()
    expect(scan).not.toHaveBeenCalled()
  })

  it('send-button click → intent → preventDefault + scan', async () => {
    harness = buildClaude()
    harness.setComposerHtml('<p>hello world this is plenty long</p>')
    const scan = vi.fn((t: string): ScanOutcome => detectDetailed(t))
    adapter = new ClaudeSubmitAdapter()
    adapter.attach(makeCore({ scan }))
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, composed: true })
    harness.button.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    await flush()
    expect(scan).toHaveBeenCalledTimes(1)
  })

  it('disabled send-button click → no intent', async () => {
    harness = buildClaude({ buttonDisabled: true })
    const scan = vi.fn((t: string): ScanOutcome => detectDetailed(t))
    adapter = new ClaudeSubmitAdapter()
    adapter.attach(makeCore({ scan }))
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, composed: true })
    harness.button.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    await flush()
    expect(scan).not.toHaveBeenCalled()
  })
})

describe('Claude — synchronous gate (native send never blocked when off)', () => {
  it('flag OFF → no interception', async () => {
    harness = buildClaude()
    const scan = vi.fn((t: string): ScanOutcome => detectDetailed(t))
    adapter = new ClaudeSubmitAdapter({ isFlagEnabled: () => false })
    adapter.attach(makeCore({ scan }))
    const event = pressEnter(harness.composer)
    expect(event.defaultPrevented).toBe(false)
    await flush()
    expect(scan).not.toHaveBeenCalled()
  })

  it('master toggle OFF → no interception', async () => {
    harness = buildClaude()
    const scan = vi.fn((t: string): ScanOutcome => detectDetailed(t))
    adapter = new ClaudeSubmitAdapter({ isMasterEnabled: () => false })
    adapter.attach(makeCore({ scan }))
    const event = pressEnter(harness.composer)
    expect(event.defaultPrevented).toBe(false)
    await flush()
    expect(scan).not.toHaveBeenCalled()
  })

  it('kill-switch disabled → native send restored', async () => {
    harness = buildClaude()
    harness.setComposerHtml('<p>plenty of clean text here</p>')
    const scan = vi.fn((t: string): ScanOutcome => detectDetailed(t))
    const core = makeCore({ scan })
    adapter = new ClaudeSubmitAdapter()
    vi.spyOn(adapter, 'resume').mockReturnValue('failed')
    adapter.attach(core)
    for (let i = 0; i < 3; i++) {
      pressEnter(harness.composer)
      await flush()
    }
    expect(core.isAdapterDisabled('claude')).toBe(true)
    scan.mockClear()
    const event = pressEnter(harness.composer)
    expect(event.defaultPrevented).toBe(false)
    await flush()
    expect(scan).not.toHaveBeenCalled()
  })
})

describe('Claude — readComposerText + resume', () => {
  it('separates multi-paragraph ProseMirror', () => {
    harness = buildClaude()
    harness.setComposerHtml('<p>Patient name</p><p>Jane Doe</p>')
    adapter = new ClaudeSubmitAdapter()
    const text = adapter.readComposerText()
    expect(text).toMatch(/Patient name\s+Jane Doe/)
    expect(text).not.toContain('Patient nameJane')
  })

  it('resolves the send button FRESH at resume (KeyboardEvent fallback when button removed)', () => {
    harness = buildClaude()
    harness.setComposerHtml('<p>text</p>')
    adapter = new ClaudeSubmitAdapter()
    ;(adapter as unknown as { pendingComposer: HTMLElement }).pendingComposer = harness.composer
    harness.button.remove()
    let gotEnter = false
    harness.composer.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') gotEnter = true
    })
    const result = adapter.resume()
    expect(gotEnter).toBe(true)
    expect(result).toBe('unknown')
  })

  it('KeyboardEvent fallback fires when the button is disabled', () => {
    harness = buildClaude({ buttonDisabled: true })
    harness.setComposerHtml('<p>text</p>')
    adapter = new ClaudeSubmitAdapter()
    ;(adapter as unknown as { pendingComposer: HTMLElement }).pendingComposer = harness.composer
    let gotEnter = false
    harness.composer.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter' && (e as KeyboardEvent).keyCode === 13)
        gotEnter = true
    })
    adapter.resume()
    expect(gotEnter).toBe(true)
  })

  it("clicks the send button and returns 'submitted' when the composer clears", () => {
    harness = buildClaude()
    harness.setComposerHtml('<p>Patient SSN is 123-45-6789</p>')
    adapter = new ClaudeSubmitAdapter()
    harness.button.addEventListener('click', () => harness!.setComposerHtml('<p></p>'))
    ;(adapter as unknown as { pendingComposer: HTMLElement }).pendingComposer = harness.composer
    expect(adapter.resume()).toBe('submitted')
  })
})

describe('Claude — end-to-end through the core', () => {
  it('clean Enter → exactly one send-button click', async () => {
    harness = buildClaude()
    harness.setComposerHtml(`<p>${CLEAN_TEXT}</p>`)
    let clicks = 0
    harness.button.addEventListener('click', () => {
      clicks += 1
      harness!.setComposerHtml('<p></p>')
    })
    adapter = new ClaudeSubmitAdapter()
    adapter.attach(makeCore())
    pressEnter(harness.composer)
    await flush()
    expect(clicks).toBe(1)
  })

  it('rapid double-Enter → coalesced → one click', async () => {
    harness = buildClaude()
    harness.setComposerHtml(`<p>${CLEAN_TEXT}</p>`)
    let clicks = 0
    harness.button.addEventListener('click', () => (clicks += 1))
    let releaseScan: (o: ScanOutcome) => void = () => {}
    const core = makeCore({ scan: () => new Promise<ScanOutcome>((r) => (releaseScan = r)) })
    adapter = new ClaudeSubmitAdapter()
    adapter.attach(core)
    pressEnter(harness.composer)
    pressEnter(harness.composer)
    await flush()
    releaseScan(detectDetailed(CLEAN_TEXT))
    await flush()
    expect(clicks).toBe(1)
  })

  it('proceed → one click; return-to-edit → zero clicks, draft intact', async () => {
    // proceed
    harness = buildClaude()
    harness.setComposerHtml(`<p>${SSN_TEXT}</p>`)
    let clicks = 0
    harness.button.addEventListener('click', () => {
      clicks += 1
      harness!.setComposerHtml('<p></p>')
    })
    let h = controllableDecide()
    adapter = new ClaudeSubmitAdapter()
    adapter.attach(makeCore({ decide: h.decide }))
    pressEnter(harness.composer)
    await flush()
    expect(h.calls).toBe(1)
    expect(clicks).toBe(0)
    h.resolve('proceed')
    await flush()
    expect(clicks).toBe(1)
    adapter.detach()
    harness.cleanup()

    // return-to-edit
    harness = buildClaude()
    harness.setComposerHtml(`<p>${SSN_TEXT}</p>`)
    clicks = 0
    harness.button.addEventListener('click', () => (clicks += 1))
    h = controllableDecide()
    adapter = new ClaudeSubmitAdapter()
    adapter.attach(makeCore({ decide: h.decide }))
    pressEnter(harness.composer)
    await flush()
    h.resolve('return-to-edit')
    await flush()
    expect(clicks).toBe(0)
    expect(harness.composer.textContent).toContain('123-45-6789')
  })
})
