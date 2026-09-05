// @vitest-environment jsdom
//
// V1.3 M3 — Gemini (gemini.google.com) submit-scan adapter tests.
// Mirrors the ChatGPT/Claude suites, plus the Gemini-specific case:
// the composer is a contenteditable INSIDE a `<rich-textarea>`
// custom element, and it must resolve through the composed path via
// the config's `matchesComposer` hook.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GeminiSubmitAdapter } from '../src/content/submit/adapters/gemini'
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

// Gemini composer: contenteditable inside a <rich-textarea> custom
// element (light DOM). Send button: Material icon button with
// aria-label="Send message" and no data-testid.
interface GeminiHarness extends Harness {
  host: HTMLElement // the <rich-textarea> host
}

function buildGemini(opts: { buttonDisabled?: boolean } = {}): GeminiHarness {
  document.body.innerHTML = ''
  const host = document.createElement('rich-textarea')
  const composer = document.createElement('div')
  composer.setAttribute('contenteditable', 'true')
  composer.setAttribute('role', 'textbox')
  composer.innerHTML = '<p></p>'
  host.appendChild(composer)
  const button = document.createElement('button')
  button.setAttribute('aria-label', 'Send message')
  button.className = 'mdc-icon-button mat-mdc-icon-button'
  if (opts.buttonDisabled) button.disabled = true
  document.body.append(host, button)
  return {
    host,
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

let harness: GeminiHarness | null = null
let adapter: GeminiSubmitAdapter | null = null

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

describe('Gemini — send-intent detection', () => {
  it('Enter inside the <rich-textarea> composer → intent → preventDefault + scan (custom-element composed-path)', async () => {
    harness = buildGemini()
    harness.setComposerHtml('<p>hello world this is plenty long</p>')
    const scan = vi.fn((t: string): ScanOutcome => detectDetailed(t))
    adapter = new GeminiSubmitAdapter()
    adapter.attach(makeCore({ scan }))
    const event = pressEnter(harness.composer)
    expect(event.defaultPrevented).toBe(true)
    await flush()
    expect(scan).toHaveBeenCalledTimes(1)
  })

  it('the <rich-textarea> custom-element wrapper resolves through matchesComposer', () => {
    harness = buildGemini()
    harness.setComposerHtml('<p>Patient SSN 123-45-6789</p>')
    adapter = new GeminiSubmitAdapter()
    // Simulate the composed-path node being the HOST (custom-element
    // boundary), not the inner contenteditable: an Enter whose target
    // is the host must still resolve to a composer and intercept.
    const scan = vi.fn((t: string): ScanOutcome => detectDetailed(t))
    adapter.attach(makeCore({ scan }))
    const event = pressEnter(harness.host)
    expect(event.defaultPrevented).toBe(true)
  })

  it('a HOST-matched event normalizes to the INNER contenteditable for read + resume', async () => {
    harness = buildGemini()
    // Put content that is only meaningful inside the editor, plus a
    // sibling inside the host that is NOT the editor — the read must
    // see only the editor.
    harness.setComposerHtml('<p>Patient SSN 123-45-6789</p>')
    const decoy = document.createElement('div')
    decoy.textContent = 'PLACEHOLDER-999-99-9999'
    harness.host.appendChild(decoy)
    const scan = vi.fn((t: string): ScanOutcome => detectDetailed(t))
    adapter = new GeminiSubmitAdapter()
    adapter.attach(makeCore({ scan }))
    pressEnter(harness.host) // event targets the host
    // Synchronously (before the async intent completes and clears it),
    // pendingComposer is the normalized INNER contenteditable.
    const pending = (adapter as unknown as { pendingComposer: HTMLElement | null }).pendingComposer
    expect(pending).toBe(harness.composer)
    await flush()
    // The scan saw the inner editor's text, not the host's decoy.
    const scanned = scan.mock.calls[0]?.[0] ?? ''
    expect(scanned).toContain('123-45-6789')
    expect(scanned).not.toContain('PLACEHOLDER-999-99-9999')
  })

  it('Shift+Enter → newline, no intent', async () => {
    harness = buildGemini()
    harness.setComposerHtml('<p>hello world this is plenty long</p>')
    const scan = vi.fn((t: string): ScanOutcome => detectDetailed(t))
    adapter = new GeminiSubmitAdapter()
    adapter.attach(makeCore({ scan }))
    const event = pressEnter(harness.composer, { shiftKey: true })
    expect(event.defaultPrevented).toBe(false)
    await flush()
    expect(scan).not.toHaveBeenCalled()
  })

  it('IME composing Enter (isComposing) → never intercepted', async () => {
    harness = buildGemini()
    harness.setComposerHtml('<p>コンポジション</p>')
    const scan = vi.fn((t: string): ScanOutcome => detectDetailed(t))
    adapter = new GeminiSubmitAdapter()
    adapter.attach(makeCore({ scan }))
    const event = pressEnter(harness.composer, { isComposing: true })
    expect(event.defaultPrevented).toBe(false)
    await flush()
    expect(scan).not.toHaveBeenCalled()
  })

  it('IME confirm Enter (keyCode 229) → never intercepted', async () => {
    harness = buildGemini()
    harness.setComposerHtml('<p>入力</p>')
    const scan = vi.fn((t: string): ScanOutcome => detectDetailed(t))
    adapter = new GeminiSubmitAdapter()
    adapter.attach(makeCore({ scan }))
    const event = pressEnter(harness.composer, { keyCode: 229 })
    expect(event.keyCode).toBe(229)
    expect(event.defaultPrevented).toBe(false)
    await flush()
    expect(scan).not.toHaveBeenCalled()
  })

  it('send-button click → intent → preventDefault + scan', async () => {
    harness = buildGemini()
    harness.setComposerHtml('<p>hello world this is plenty long</p>')
    const scan = vi.fn((t: string): ScanOutcome => detectDetailed(t))
    adapter = new GeminiSubmitAdapter()
    adapter.attach(makeCore({ scan }))
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, composed: true })
    harness.button.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    await flush()
    expect(scan).toHaveBeenCalledTimes(1)
  })

  it('disabled send-button click → no intent', async () => {
    harness = buildGemini({ buttonDisabled: true })
    const scan = vi.fn((t: string): ScanOutcome => detectDetailed(t))
    adapter = new GeminiSubmitAdapter()
    adapter.attach(makeCore({ scan }))
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, composed: true })
    harness.button.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    await flush()
    expect(scan).not.toHaveBeenCalled()
  })
})

describe('Gemini — synchronous gate (native send never blocked when off)', () => {
  it('flag OFF → no interception', async () => {
    harness = buildGemini()
    const scan = vi.fn((t: string): ScanOutcome => detectDetailed(t))
    adapter = new GeminiSubmitAdapter({ isFlagEnabled: () => false })
    adapter.attach(makeCore({ scan }))
    const event = pressEnter(harness.composer)
    expect(event.defaultPrevented).toBe(false)
    await flush()
    expect(scan).not.toHaveBeenCalled()
  })

  it('master toggle OFF → no interception', async () => {
    harness = buildGemini()
    const scan = vi.fn((t: string): ScanOutcome => detectDetailed(t))
    adapter = new GeminiSubmitAdapter({ isMasterEnabled: () => false })
    adapter.attach(makeCore({ scan }))
    const event = pressEnter(harness.composer)
    expect(event.defaultPrevented).toBe(false)
    await flush()
    expect(scan).not.toHaveBeenCalled()
  })

  it('kill-switch disabled → native send restored', async () => {
    harness = buildGemini()
    harness.setComposerHtml('<p>plenty of clean text here</p>')
    const scan = vi.fn((t: string): ScanOutcome => detectDetailed(t))
    const core = makeCore({ scan })
    adapter = new GeminiSubmitAdapter()
    vi.spyOn(adapter, 'resume').mockReturnValue('failed')
    adapter.attach(core)
    for (let i = 0; i < 3; i++) {
      pressEnter(harness.composer)
      await flush()
    }
    expect(core.isAdapterDisabled('gemini')).toBe(true)
    scan.mockClear()
    const event = pressEnter(harness.composer)
    expect(event.defaultPrevented).toBe(false)
    await flush()
    expect(scan).not.toHaveBeenCalled()
  })
})

describe('Gemini — readComposerText + resume', () => {
  it('separates multi-paragraph content', () => {
    harness = buildGemini()
    harness.setComposerHtml('<p>Patient name</p><p>Jane Doe</p>')
    adapter = new GeminiSubmitAdapter()
    const text = adapter.readComposerText()
    expect(text).toMatch(/Patient name\s+Jane Doe/)
    expect(text).not.toContain('Patient nameJane')
  })

  it('resolves the send button FRESH at resume (KeyboardEvent fallback when button removed)', () => {
    harness = buildGemini()
    harness.setComposerHtml('<p>text</p>')
    adapter = new GeminiSubmitAdapter()
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
    harness = buildGemini({ buttonDisabled: true })
    harness.setComposerHtml('<p>text</p>')
    adapter = new GeminiSubmitAdapter()
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
    harness = buildGemini()
    harness.setComposerHtml('<p>Patient SSN is 123-45-6789</p>')
    adapter = new GeminiSubmitAdapter()
    harness.button.addEventListener('click', () => harness!.setComposerHtml('<p></p>'))
    ;(adapter as unknown as { pendingComposer: HTMLElement }).pendingComposer = harness.composer
    expect(adapter.resume()).toBe('submitted')
  })
})

describe('Gemini — end-to-end through the core', () => {
  it('clean Enter → exactly one send-button click', async () => {
    harness = buildGemini()
    harness.setComposerHtml(`<p>${CLEAN_TEXT}</p>`)
    let clicks = 0
    harness.button.addEventListener('click', () => {
      clicks += 1
      harness!.setComposerHtml('<p></p>')
    })
    adapter = new GeminiSubmitAdapter()
    adapter.attach(makeCore())
    pressEnter(harness.composer)
    await flush()
    expect(clicks).toBe(1)
  })

  it('rapid double-Enter → coalesced → one click', async () => {
    harness = buildGemini()
    harness.setComposerHtml(`<p>${CLEAN_TEXT}</p>`)
    let clicks = 0
    harness.button.addEventListener('click', () => (clicks += 1))
    let releaseScan: (o: ScanOutcome) => void = () => {}
    const core = makeCore({ scan: () => new Promise<ScanOutcome>((r) => (releaseScan = r)) })
    adapter = new GeminiSubmitAdapter()
    adapter.attach(core)
    pressEnter(harness.composer)
    pressEnter(harness.composer)
    await flush()
    releaseScan(detectDetailed(CLEAN_TEXT))
    await flush()
    expect(clicks).toBe(1)
  })

  it('proceed → one click; return-to-edit → zero clicks, draft intact', async () => {
    harness = buildGemini()
    harness.setComposerHtml(`<p>${SSN_TEXT}</p>`)
    let clicks = 0
    harness.button.addEventListener('click', () => {
      clicks += 1
      harness!.setComposerHtml('<p></p>')
    })
    let h = controllableDecide()
    adapter = new GeminiSubmitAdapter()
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

    harness = buildGemini()
    harness.setComposerHtml(`<p>${SSN_TEXT}</p>`)
    clicks = 0
    harness.button.addEventListener('click', () => (clicks += 1))
    h = controllableDecide()
    adapter = new GeminiSubmitAdapter()
    adapter.attach(makeCore({ decide: h.decide }))
    pressEnter(harness.composer)
    await flush()
    h.resolve('return-to-edit')
    await flush()
    expect(clicks).toBe(0)
    expect(harness.composer.textContent).toContain('123-45-6789')
  })
})
