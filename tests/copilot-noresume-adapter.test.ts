// @vitest-environment jsdom
//
// V1.3.1 — the Copilot NO-RESUME send adapter. Copilot cannot be resumed
// (untrusted click → CAPTCHA), so this adapter has NO programmatic-send
// seam: it only BLOCKS a flagged native send and warns; the user presses
// Send again themselves. These tests pin that contract on the live-
// confirmed Copilot DOM (Lexical contenteditable + `button[aria-label=Send]`).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CopilotNoResumeAdapter,
  MAX_SYNC_SCAN_CHARS,
} from '../src/content/submit/adapters/copilot-noresume'
import {
  isDocumentModalOpen,
  __getModalShadowForTests,
  __resetDocumentModalForTests,
} from '../src/content/document-modal'
import { detectDetailed } from '../src/detector/engine'
import type { AlgEvent } from '../src/shared/event-log'

const SSN_TEXT = 'Patient SSN is 123-45-6789'
const SSN_TEXT_2 = 'SSN 123-45-6789 and SSN 321-54-9876' // different risk shape (2 vs 1)
const CLEAN_TEXT = 'What is the capital of France?'

interface Rig {
  composer: HTMLElement
  button: HTMLButtonElement
  sendClicks: number
  composerKeydowns: number
}

function build(): Rig {
  document.body.innerHTML = ''
  const composer = document.createElement('span')
  composer.id = 'm365-chat-editor-target-element'
  composer.setAttribute('contenteditable', 'true')
  composer.setAttribute('role', 'textbox')
  composer.setAttribute('data-lexical-editor', 'true')
  composer.innerHTML = '<p></p>'
  const button = document.createElement('button')
  button.setAttribute('aria-label', 'Send')
  document.body.append(composer, button)
  const rig: Rig = { composer, button, sendClicks: 0, composerKeydowns: 0 }
  // Instrument the site's own send handlers so we can prove the adapter
  // NEVER triggers them programmatically.
  button.addEventListener('click', () => (rig.sendClicks += 1))
  composer.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') rig.composerKeydowns += 1
  })
  return rig
}

let adapter: CopilotNoResumeAdapter | null = null
const logged: AlgEvent[] = []

function makeAdapter(opts: ConstructorParameters<typeof CopilotNoResumeAdapter>[0] = {}) {
  adapter = new CopilotNoResumeAdapter({ logEvent: (e) => logged.push(e), ...opts })
  adapter.attach()
  return adapter
}

function pressEnter(el: HTMLElement, init: Partial<KeyboardEventInit & { keyCode: number }> = {}) {
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
  el.focus()
  el.dispatchEvent(event)
  return event
}

async function flush(n = 6): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

/** Click a modal button by its visible label (closed shadow root). */
function clickModalButton(label: string): void {
  const shadow = __getModalShadowForTests()
  if (shadow === null) throw new Error('no modal open')
  const btn = Array.from(shadow.querySelectorAll('button')).find(
    (b) => (b.textContent ?? '').trim() === label,
  )
  if (btn === undefined) throw new Error(`no modal button "${label}"`)
  ;(btn as HTMLButtonElement).click()
}

beforeEach(() => {
  logged.length = 0
})
afterEach(() => {
  adapter?.detach()
  adapter = null
  __resetDocumentModalForTests()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('Copilot no-resume — clean & fail-open never intercept', () => {
  it('clean send → does NOT preventDefault, no modal (native trusted send proceeds)', async () => {
    const rig = build()
    rig.composer.innerHTML = `<p>${CLEAN_TEXT}</p>`
    makeAdapter()
    const event = pressEnter(rig.composer)
    expect(event.defaultPrevented).toBe(false)
    await flush()
    expect(isDocumentModalOpen()).toBe(false)
    expect(logged.some((e) => e.action === 'auto-cleared')).toBe(true)
  })

  it('fail-open (over the sync-scan cap) → does NOT preventDefault + logs unable-to-inspect', async () => {
    const rig = build()
    rig.composer.innerHTML = `<p>${'a'.repeat(MAX_SYNC_SCAN_CHARS + 1)}</p>`
    makeAdapter()
    const event = pressEnter(rig.composer)
    expect(event.defaultPrevented).toBe(false)
    await flush()
    expect(isDocumentModalOpen()).toBe(false)
    expect(logged.some((e) => e.action === 'unable-to-inspect')).toBe(true)
  })

  it('fail-open (scan throws) → does NOT preventDefault + logs unable-to-inspect', async () => {
    const rig = build()
    rig.composer.innerHTML = `<p>${SSN_TEXT}</p>`
    makeAdapter({
      scan: () => {
        throw new Error('boom')
      },
    })
    const event = pressEnter(rig.composer)
    expect(event.defaultPrevented).toBe(false)
    await flush()
    expect(isDocumentModalOpen()).toBe(false)
    expect(logged.some((e) => e.action === 'unable-to-inspect')).toBe(true)
  })
})

describe('Copilot no-resume — flagged blocks & warns, NEVER sends programmatically', () => {
  it('flagged Enter → preventDefault + modal; no synthetic send on any path', async () => {
    const rig = build()
    rig.composer.innerHTML = `<p>${SSN_TEXT}</p>`
    makeAdapter()
    const event = pressEnter(rig.composer)
    expect(event.defaultPrevented).toBe(true)
    await flush()
    expect(isDocumentModalOpen()).toBe(true)
    // The adapter never clicked the send button nor dispatched an Enter.
    // The composer's own keydown listener sees NOTHING: our real Enter was
    // blocked (stopImmediatePropagation), and the adapter added no synthetic
    // keydown — so 0 proves both no leak-through and no programmatic re-send.
    expect(rig.sendClicks).toBe(0)
    expect(rig.composerKeydowns).toBe(0)
    // The primary label tells the user to press Send again.
    const shadow = __getModalShadowForTests()
    const primary = shadow?.querySelector('.btn--primary')?.textContent ?? ''
    expect(primary).toBe('Proceed — press Send again')
  })

  it('flagged send-button CLICK → preventDefault + modal (click path)', async () => {
    const rig = build()
    rig.composer.innerHTML = `<p>${SSN_TEXT}</p>`
    makeAdapter()
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, composed: true })
    rig.button.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    await flush()
    expect(isDocumentModalOpen()).toBe(true)
  })

  it('return-to-edit → nothing sent, draft intact, logged cancelled', async () => {
    const rig = build()
    rig.composer.innerHTML = `<p>${SSN_TEXT}</p>`
    makeAdapter()
    pressEnter(rig.composer)
    await flush()
    clickModalButton('Return to editing')
    await flush()
    expect(rig.sendClicks).toBe(0)
    expect(rig.composer.textContent).toContain('123-45-6789')
    expect(logged.some((e) => e.action === 'cancelled')).toBe(true)
  })
})

describe('Copilot no-resume — acknowledgement (two-press) flow', () => {
  it('proceed sets ack; the SAME content re-pressed passes through (no preventDefault, no modal, native send)', async () => {
    const rig = build()
    rig.composer.innerHTML = `<p>${SSN_TEXT}</p>`
    makeAdapter()
    // First press → blocked + modal.
    const first = pressEnter(rig.composer)
    expect(first.defaultPrevented).toBe(true)
    await flush()
    clickModalButton('Proceed — press Send again')
    await flush()
    expect(logged.filter((e) => e.action === 'as-is').length).toBe(1)
    // Second (trusted) press of the SAME content → passes through.
    const second = pressEnter(rig.composer)
    expect(second.defaultPrevented).toBe(false)
    await flush()
    expect(isDocumentModalOpen()).toBe(false)
    expect(rig.sendClicks).toBe(0) // adapter still never clicks anything
  })

  it('after proceed, editing to a DIFFERENT risk shape re-warns', async () => {
    const rig = build()
    rig.composer.innerHTML = `<p>${SSN_TEXT}</p>`
    makeAdapter()
    pressEnter(rig.composer)
    await flush()
    clickModalButton('Proceed — press Send again')
    await flush()
    // Change the risk shape (1 SSN → 2 SSNs): the ack must not apply.
    rig.composer.innerHTML = `<p>${SSN_TEXT_2}</p>`
    const event = pressEnter(rig.composer)
    expect(event.defaultPrevented).toBe(true)
    await flush()
    expect(isDocumentModalOpen()).toBe(true)
  })

  it('ack cleared when the composer empties → next same-shape message re-warns', async () => {
    const rig = build()
    rig.composer.innerHTML = `<p>${SSN_TEXT}</p>`
    makeAdapter()
    pressEnter(rig.composer)
    await flush()
    clickModalButton('Proceed — press Send again')
    await flush()
    // Message sends → Copilot clears the composer. The MutationObserver
    // clears the ack.
    rig.composer.innerHTML = ''
    await flush()
    // A NEW message of the same risk shape must re-warn (not dedup-skip).
    rig.composer.innerHTML = `<p>${SSN_TEXT}</p>`
    const event = pressEnter(rig.composer)
    expect(event.defaultPrevented).toBe(true)
    await flush()
    expect(isDocumentModalOpen()).toBe(true)
  })
})

describe('Copilot no-resume — IME & Shift+Enter never intercepted', () => {
  it('Shift+Enter → newline, no intent', async () => {
    const rig = build()
    rig.composer.innerHTML = `<p>${SSN_TEXT}</p>`
    makeAdapter()
    const event = pressEnter(rig.composer, { shiftKey: true })
    expect(event.defaultPrevented).toBe(false)
    await flush()
    expect(isDocumentModalOpen()).toBe(false)
  })

  it('IME composing Enter (isComposing) → never intercepted', async () => {
    const rig = build()
    rig.composer.innerHTML = `<p>${SSN_TEXT}</p>`
    makeAdapter()
    const event = pressEnter(rig.composer, { isComposing: true })
    expect(event.defaultPrevented).toBe(false)
    await flush()
    expect(isDocumentModalOpen()).toBe(false)
  })

  it('IME confirm Enter (keyCode 229) → never intercepted', async () => {
    const rig = build()
    rig.composer.innerHTML = `<p>${SSN_TEXT}</p>`
    makeAdapter()
    const event = pressEnter(rig.composer, { keyCode: 229 })
    expect(event.keyCode).toBe(229)
    expect(event.defaultPrevented).toBe(false)
    await flush()
    expect(isDocumentModalOpen()).toBe(false)
  })
})

describe('Copilot no-resume — structural: no programmatic-send seam exists', () => {
  it('the adapter never exposes resume/send and never calls click()/dispatchEvent on the send controls', async () => {
    const rig = build()
    rig.composer.innerHTML = `<p>${SSN_TEXT}</p>`
    const a = makeAdapter()
    // No resume/send method on the instance (unlike the base adapters).
    expect('resume' in a).toBe(false)
    expect((a as unknown as { send?: unknown }).send).toBeUndefined()
    // Even across a full proceed cycle, the site's own send controls are
    // never triggered by the adapter.
    pressEnter(rig.composer)
    await flush()
    clickModalButton('Proceed — press Send again')
    await flush()
    expect(rig.sendClicks).toBe(0)
    // detectDetailed is the real detector for these flagged cases.
    expect(detectDetailed(SSN_TEXT).hasCriticalOrHigh).toBe(true)
  })
})
