// @vitest-environment jsdom
//
// V1.3 M2 — ChatGPT submit-scan adapter tests.
//
// The M1 core's state machine + re-entrancy + fail-open + dedup +
// kill-switch are already pinned in `tests/submit-core.test.ts`
// against a FakeAdapter. This suite covers the ChatGPT-SPECIFIC
// surface that M2 adds:
//   • send-intent detection: Enter → intent; Shift+Enter → none;
//     IME (`isComposing` / `keyCode 229`) → none; send-button click
//     → intent; disabled button / non-composer Enter → none.
//   • the flag / master-toggle / kill-switch synchronous gate
//     (native send never blocked when off).
//   • `readComposerText` separates multi-paragraph ProseMirror.
//   • `resume()` post-check → submitted / failed / unknown; button
//     resolved fresh at resume time; KeyboardEvent fallback.
//   • one send intent → at most one submission (idempotent resume),
//     re-entrancy coalescing at the DOM-event layer.

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

// ── DOM builders (a minimal ChatGPT composer + send button) ──

interface Harness {
  composer: HTMLElement
  button: HTMLButtonElement
  setComposerHtml: (html: string) => void
  cleanup: () => void
}

function buildComposer(opts: { buttonTestId?: string; buttonDisabled?: boolean } = {}): Harness {
  document.body.innerHTML = ''
  const composer = document.createElement('div')
  composer.id = 'prompt-textarea'
  composer.setAttribute('contenteditable', 'true')
  composer.setAttribute('role', 'textbox')
  composer.innerHTML = '<p></p>'
  const button = document.createElement('button')
  button.setAttribute('data-testid', opts.buttonTestId ?? 'send-button')
  button.setAttribute('aria-label', 'Send prompt')
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

// A decision seam the test controls. Records summaries; resolves on demand.
function controllableDecide() {
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

function makeCore(overrides: Partial<SubmitCoreDeps> = {}) {
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

// Dispatch a capture-phase-observable keydown from the composer.
function pressEnter(
  composer: HTMLElement,
  init: Partial<KeyboardEventInit & { keyCode: number }> = {},
): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: 'Enter',
    bubbles: true,
    cancelable: true,
    composed: true,
    ...init,
  })
  if (init.keyCode !== undefined && event.keyCode !== init.keyCode) {
    Object.defineProperty(event, 'keyCode', { get: () => init.keyCode })
  }
  composer.focus()
  composer.dispatchEvent(event)
  return event
}

async function flush(n = 8): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

let harness: Harness | null = null
let adapter: ChatGptSubmitAdapter | null = null

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

// ─────────────────────────────────────────────────────────────────────

describe('send-intent detection', () => {
  it('Enter (no modifiers) into the composer → intent → preventDefault + core scan', async () => {
    harness = buildComposer()
    harness.setComposerHtml('<p>hello world this is plenty long</p>')
    const scan = vi.fn((t: string): ScanOutcome => detectDetailed(t))
    const core = makeCore({ scan })
    adapter = new ChatGptSubmitAdapter()
    adapter.attach(core)

    const event = pressEnter(harness.composer)
    expect(event.defaultPrevented).toBe(true)
    await flush()
    expect(scan).toHaveBeenCalledTimes(1)
  })

  it('Shift+Enter → no intent (newline), native default preserved', async () => {
    harness = buildComposer()
    harness.setComposerHtml('<p>hello world this is plenty long</p>')
    const scan = vi.fn((t: string): ScanOutcome => detectDetailed(t))
    adapter = new ChatGptSubmitAdapter()
    adapter.attach(makeCore({ scan }))

    const event = pressEnter(harness.composer, { shiftKey: true })
    expect(event.defaultPrevented).toBe(false)
    await flush()
    expect(scan).not.toHaveBeenCalled()
  })

  it('IME composing Enter (isComposing) → NEVER intercepted (CJK)', async () => {
    harness = buildComposer()
    harness.setComposerHtml('<p>コンポジション</p>')
    const scan = vi.fn((t: string): ScanOutcome => detectDetailed(t))
    adapter = new ChatGptSubmitAdapter()
    adapter.attach(makeCore({ scan }))

    const event = pressEnter(harness.composer, { isComposing: true })
    expect(event.defaultPrevented).toBe(false)
    await flush()
    expect(scan).not.toHaveBeenCalled()
  })

  it('IME confirm Enter (keyCode 229) → NEVER intercepted (CJK)', async () => {
    harness = buildComposer()
    harness.setComposerHtml('<p>入力</p>')
    const scan = vi.fn((t: string): ScanOutcome => detectDetailed(t))
    adapter = new ChatGptSubmitAdapter()
    adapter.attach(makeCore({ scan }))

    const event = pressEnter(harness.composer, { keyCode: 229 })
    expect(event.keyCode).toBe(229)
    expect(event.defaultPrevented).toBe(false)
    await flush()
    expect(scan).not.toHaveBeenCalled()
  })

  it('Enter NOT targeting the composer → no intent', async () => {
    harness = buildComposer()
    const other = document.createElement('input')
    document.body.appendChild(other)
    const scan = vi.fn((t: string): ScanOutcome => detectDetailed(t))
    adapter = new ChatGptSubmitAdapter()
    adapter.attach(makeCore({ scan }))

    other.focus()
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    other.dispatchEvent(event)
    await flush()
    expect(event.defaultPrevented).toBe(false)
    expect(scan).not.toHaveBeenCalled()
  })

  it('send-button click → intent → preventDefault + core scan', async () => {
    harness = buildComposer()
    harness.setComposerHtml('<p>hello world this is plenty long</p>')
    const scan = vi.fn((t: string): ScanOutcome => detectDetailed(t))
    adapter = new ChatGptSubmitAdapter()
    adapter.attach(makeCore({ scan }))

    const event = new MouseEvent('click', { bubbles: true, cancelable: true, composed: true })
    harness.button.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    await flush()
    expect(scan).toHaveBeenCalledTimes(1)
  })

  it('disabled send-button click → no intent', async () => {
    harness = buildComposer({ buttonDisabled: true })
    const scan = vi.fn((t: string): ScanOutcome => detectDetailed(t))
    adapter = new ChatGptSubmitAdapter()
    adapter.attach(makeCore({ scan }))

    const event = new MouseEvent('click', { bubbles: true, cancelable: true, composed: true })
    harness.button.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    await flush()
    expect(scan).not.toHaveBeenCalled()
  })
})

describe('synchronous gate (native send never blocked when off)', () => {
  it('flag OFF → no interception at all', async () => {
    harness = buildComposer()
    const scan = vi.fn((t: string): ScanOutcome => detectDetailed(t))
    adapter = new ChatGptSubmitAdapter({ isFlagEnabled: () => false })
    adapter.attach(makeCore({ scan }))
    const event = pressEnter(harness.composer)
    expect(event.defaultPrevented).toBe(false)
    await flush()
    expect(scan).not.toHaveBeenCalled()
  })

  it('master toggle OFF → no interception', async () => {
    harness = buildComposer()
    const scan = vi.fn((t: string): ScanOutcome => detectDetailed(t))
    adapter = new ChatGptSubmitAdapter({ isMasterEnabled: () => false })
    adapter.attach(makeCore({ scan }))
    const event = pressEnter(harness.composer)
    expect(event.defaultPrevented).toBe(false)
    await flush()
    expect(scan).not.toHaveBeenCalled()
  })

  it('adapter disabled by the core kill switch → no interception (native send restored)', async () => {
    harness = buildComposer()
    harness.setComposerHtml('<p>plenty of clean text here</p>')
    const scan = vi.fn((t: string): ScanOutcome => detectDetailed(t))
    // resume always fails → after threshold the core disables the adapter.
    const core = makeCore({ scan })
    adapter = new ChatGptSubmitAdapter()
    // Force resume to fail by removing the button + composer at resume.
    const failing = adapter
    vi.spyOn(failing, 'resume').mockReturnValue('failed')
    adapter.attach(core)
    for (let i = 0; i < 3; i++) {
      pressEnter(harness.composer)
      await flush()
    }
    expect(core.isAdapterDisabled('chatgpt')).toBe(true)
    scan.mockClear()
    const event = pressEnter(harness.composer)
    expect(event.defaultPrevented).toBe(false)
    await flush()
    expect(scan).not.toHaveBeenCalled()
  })
})

describe('readComposerText — multi-paragraph ProseMirror separation', () => {
  it('separates <p> blocks so adjacent paragraphs do not glue', () => {
    harness = buildComposer()
    harness.setComposerHtml('<p>Patient name</p><p>Jane Doe</p>')
    adapter = new ChatGptSubmitAdapter()
    // No attach needed for a direct read, but resolve via the fresh
    // query path (pendingComposer is null).
    const text = adapter.readComposerText()
    expect(text).toMatch(/Patient name\s+Jane Doe/)
    expect(text).not.toContain('Patient nameJane')
  })

  it('a <br>-split identifier and glued spans are separated (EMR walk reuse)', () => {
    harness = buildComposer()
    harness.setComposerHtml('<p><span>SSN</span><span>123-45-6789</span></p>')
    adapter = new ChatGptSubmitAdapter()
    const text = adapter.readComposerText()
    // The EMR walk inserts a boundary between glued inline spans.
    expect(text).toMatch(/SSN\s+123-45-6789/)
    // And detection then fires on the separated text.
    expect(detectDetailed(text).hasCriticalOrHigh).toBe(true)
  })

  it('returns "" when no composer is present', () => {
    document.body.innerHTML = ''
    adapter = new ChatGptSubmitAdapter()
    expect(adapter.readComposerText()).toBe('')
  })
})

describe('resume() — button resolved fresh, post-check, fallback', () => {
  it("clicks the send button and returns 'submitted' when the composer clears", () => {
    harness = buildComposer()
    harness.setComposerHtml('<p>Patient SSN is 123-45-6789</p>')
    adapter = new ChatGptSubmitAdapter()
    // Attach so pendingComposer is set the way a real intent would;
    // simulate ChatGPT clearing the composer on click.
    const clearOnClick = harness
    harness.button.addEventListener('click', () => {
      clearOnClick.setComposerHtml('<p></p>')
    })
    // Prime pendingComposer via a real intent, then resume is called
    // by the core; here we call resume() directly to isolate it.
    ;(adapter as unknown as { pendingComposer: HTMLElement }).pendingComposer = harness.composer
    const result = adapter.resume()
    expect(result).toBe('submitted')
  })

  it("returns 'unknown' when a live button was clicked but text is unchanged (async-clear race)", () => {
    harness = buildComposer()
    harness.setComposerHtml('<p>Patient SSN is 123-45-6789</p>')
    adapter = new ChatGptSubmitAdapter()
    ;(adapter as unknown as { pendingComposer: HTMLElement }).pendingComposer = harness.composer
    // Button stays enabled, composer text unchanged → cannot confirm.
    const result = adapter.resume()
    expect(result).toBe('unknown')
  })

  it("returns 'failed' when there is no usable button AND no composer", () => {
    document.body.innerHTML = ''
    adapter = new ChatGptSubmitAdapter()
    expect(adapter.resume()).toBe('failed')
  })

  it('resolves the send button FRESH at resume time (not cached)', () => {
    harness = buildComposer()
    harness.setComposerHtml('<p>text</p>')
    adapter = new ChatGptSubmitAdapter()
    ;(adapter as unknown as { pendingComposer: HTMLElement }).pendingComposer = harness.composer
    // Remove the button entirely; a cached reference would still be
    // clicked. With fresh resolution there is no button → fallback
    // to KeyboardEvent on the composer → attempted → 'unknown'.
    harness.button.remove()
    let gotEnter = false
    harness.composer.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') gotEnter = true
    })
    const result = adapter.resume()
    expect(gotEnter).toBe(true) // fallback fired
    expect(result).toBe('unknown')
  })

  it('KeyboardEvent fallback fires when the button is disabled', () => {
    harness = buildComposer({ buttonDisabled: true })
    harness.setComposerHtml('<p>text</p>')
    adapter = new ChatGptSubmitAdapter()
    ;(adapter as unknown as { pendingComposer: HTMLElement }).pendingComposer = harness.composer
    let gotEnter = false
    harness.composer.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter' && (e as KeyboardEvent).keyCode === 13)
        gotEnter = true
    })
    adapter.resume()
    expect(gotEnter).toBe(true)
  })
})

describe('one intent → at most one submission (end-to-end through the core, clean path)', () => {
  it('clean Enter → exactly one send-button click', async () => {
    harness = buildComposer()
    harness.setComposerHtml(`<p>${CLEAN_TEXT}</p>`)
    let clicks = 0
    harness.button.addEventListener('click', () => {
      clicks += 1
      harness!.setComposerHtml('<p></p>') // ChatGPT clears on send
    })
    const core = makeCore()
    adapter = new ChatGptSubmitAdapter()
    adapter.attach(core)

    pressEnter(harness.composer)
    await flush()
    expect(clicks).toBe(1)
  })

  it('rapid double-Enter → coalesced → still exactly one click', async () => {
    harness = buildComposer()
    harness.setComposerHtml(`<p>${CLEAN_TEXT}</p>`)
    let clicks = 0
    harness.button.addEventListener('click', () => {
      clicks += 1
    })
    // Hold the scan so both Enters land while HELD_SCANNING.
    let releaseScan: (o: ScanOutcome) => void = () => {}
    const core = makeCore({
      scan: () => new Promise<ScanOutcome>((r) => (releaseScan = r)),
    })
    adapter = new ChatGptSubmitAdapter()
    adapter.attach(core)

    pressEnter(harness.composer)
    pressEnter(harness.composer)
    await flush()
    releaseScan(detectDetailed(CLEAN_TEXT))
    await flush()
    expect(clicks).toBe(1)
  })
})

describe('flagged path → modal decision → proceed / return-to-edit', () => {
  it('proceed → one click; return-to-edit → zero clicks, draft intact', async () => {
    // proceed
    {
      harness = buildComposer()
      harness.setComposerHtml(`<p>${SSN_TEXT}</p>`)
      let clicks = 0
      harness.button.addEventListener('click', () => {
        clicks += 1
        harness!.setComposerHtml('<p></p>')
      })
      const h = controllableDecide()
      const core = makeCore({ decide: h.decide })
      adapter = new ChatGptSubmitAdapter()
      adapter.attach(core)
      const p = core // keep ref
      void p
      pressEnter(harness.composer)
      await flush()
      expect(h.calls).toBe(1)
      expect(clicks).toBe(0)
      h.resolve('proceed')
      await flush()
      expect(clicks).toBe(1)
      adapter.detach()
      harness.cleanup()
    }
    // return-to-edit
    {
      harness = buildComposer()
      harness.setComposerHtml(`<p>${SSN_TEXT}</p>`)
      let clicks = 0
      harness.button.addEventListener('click', () => {
        clicks += 1
      })
      const h = controllableDecide()
      const core = makeCore({ decide: h.decide })
      adapter = new ChatGptSubmitAdapter()
      adapter.attach(core)
      pressEnter(harness.composer)
      await flush()
      h.resolve('return-to-edit')
      await flush()
      expect(clicks).toBe(0)
      expect(harness.composer.textContent).toContain('123-45-6789') // draft intact
    }
  })
})
