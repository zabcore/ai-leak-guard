// @vitest-environment jsdom
//
// V1.3.5 — the MAIN-world Enter-reclaim shim (Gemini). Covers the pure send-Enter
// classifier and the armed/dormant blocking + bridge behaviour.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  isComposerSendEnter,
  createSendCapture,
  GEMINI_COMPOSER_SELECTOR,
  __resetSendCaptureForTests,
} from '../src/content/main-world/send-capture'
import {
  readyMessage,
  selfTestProbeMessage,
  isSendIntent,
  isSendHello,
  isSelfTestProbeResult,
} from '../src/content/main-world/send-messages'

function buildComposer(): { host: HTMLElement; editor: HTMLElement; outside: HTMLElement } {
  document.body.innerHTML = ''
  const host = document.createElement('rich-textarea')
  const editor = document.createElement('div')
  editor.className = 'ql-editor'
  editor.setAttribute('contenteditable', 'true')
  host.appendChild(editor)
  const outside = document.createElement('button')
  document.body.append(host, outside)
  return { host, editor, outside }
}

/** Dispatch a keydown from `el` and report what the shim classifier decides. */
function classify(el: HTMLElement, init: Partial<KeyboardEventInit & { keyCode: number }>): boolean {
  let result = false
  const handler = (e: Event): void => {
    result = isComposerSendEnter(e as KeyboardEvent, GEMINI_COMPOSER_SELECTOR)
  }
  window.addEventListener('keydown', handler, true)
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
  el.dispatchEvent(event)
  window.removeEventListener('keydown', handler, true)
  return result
}

// jsdom does not set MessageEvent.source for window.postMessage, so deliver
// inbound messages with an explicit source (matching the FSA test convention).
function deliver(data: unknown): void {
  window.dispatchEvent(new MessageEvent('message', { data, source: window, origin: window.origin }))
}

beforeEach(() => {
  // The module auto-installs a shim on import; tear it down so each case
  // controls its own controller (jsdom has a real `window`).
  __resetSendCaptureForTests()
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('isComposerSendEnter', () => {
  it('true for a plain Enter targeting the .ql-editor', () => {
    const { editor } = buildComposer()
    expect(classify(editor, {})).toBe(true)
  })

  it('true for Enter targeting the <rich-textarea> host', () => {
    const { host } = buildComposer()
    expect(classify(host, {})).toBe(true)
  })

  it('false for Shift+Enter (newline)', () => {
    const { editor } = buildComposer()
    expect(classify(editor, { shiftKey: true })).toBe(false)
  })

  it('false for an IME composition Enter (isComposing)', () => {
    const { editor } = buildComposer()
    expect(classify(editor, { isComposing: true })).toBe(false)
  })

  it('false for an IME confirm Enter (keyCode 229)', () => {
    const { editor } = buildComposer()
    expect(classify(editor, { keyCode: 229 })).toBe(false)
  })

  it('false for a non-Enter key', () => {
    const { editor } = buildComposer()
    let result = true
    const handler = (e: Event): void => {
      result = isComposerSendEnter(e as KeyboardEvent, GEMINI_COMPOSER_SELECTOR)
    }
    window.addEventListener('keydown', handler, true)
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true, composed: true }))
    window.removeEventListener('keydown', handler, true)
    expect(result).toBe(false)
  })

  it('false for Enter outside the composer', () => {
    const { outside } = buildComposer()
    expect(classify(outside, {})).toBe(false)
  })
})

describe('createSendCapture', () => {
  it('stays DORMANT until the isolated bridge posts ready (fail-open)', () => {
    const { editor } = buildComposer()
    const controller = createSendCapture({ win: window, origin: window.origin })
    controller.install()
    expect(controller.isArmed()).toBe(false)

    // Not armed → a composer Enter is NOT blocked (native send proceeds).
    const before = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
      composed: true,
    })
    editor.dispatchEvent(before)
    expect(before.defaultPrevented).toBe(false)
    controller.destroy()
  })

  it('arms on ready, then BLOCKS a composer Enter and posts send-intent', async () => {
    const { editor } = buildComposer()
    const posted: unknown[] = []
    const capture = (e: MessageEvent): void => {
      posted.push(e.data)
    }
    window.addEventListener('message', capture)

    const controller = createSendCapture({ win: window, origin: window.origin })
    controller.install()
    // Simulate the isolated bridge arming the shim.
    deliver(readyMessage)
    expect(controller.isArmed()).toBe(true)

    const event = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
      composed: true,
    })
    editor.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)

    await new Promise((r) => setTimeout(r, 0))
    // The shim posted hello (on install) and a send-intent (on the blocked Enter).
    expect(posted.some(isSendHello)).toBe(true)
    expect(posted.some(isSendIntent)).toBe(true)

    window.removeEventListener('message', capture)
    controller.destroy()
  })

  it('self-test-probe: arms, blocks a probe Enter on the composer, reports blocked=true', async () => {
    buildComposer()
    const posted: unknown[] = []
    const capture = (e: MessageEvent): void => void posted.push(e.data)
    window.addEventListener('message', capture)

    const controller = createSendCapture({ win: window, origin: window.origin })
    controller.install()
    // The probe both arms the shim and dispatches a synthetic Enter in-world.
    deliver(selfTestProbeMessage)
    await new Promise((r) => setTimeout(r, 0))

    const result = posted.find(isSelfTestProbeResult)
    expect(result).toBeDefined()
    expect(result && isSelfTestProbeResult(result) && result.blocked).toBe(true)
    expect(controller.isArmed()).toBe(true)

    window.removeEventListener('message', capture)
    controller.destroy()
  })

  it('self-test-probe: reports blocked=false when another capture listener wins the race first', async () => {
    buildComposer()
    // A competitor registered BEFORE the shim (like Gemini) that swallows Enter.
    const swallow = (e: Event): void => {
      if ((e as KeyboardEvent).key === 'Enter') e.stopImmediatePropagation()
    }
    window.addEventListener('keydown', swallow, true)

    const posted: unknown[] = []
    const capture = (e: MessageEvent): void => void posted.push(e.data)
    window.addEventListener('message', capture)

    const controller = createSendCapture({ win: window, origin: window.origin })
    controller.install()
    deliver(selfTestProbeMessage)
    await new Promise((r) => setTimeout(r, 0))

    const result = posted.find(isSelfTestProbeResult)
    expect(result && isSelfTestProbeResult(result) && result.blocked).toBe(false)

    window.removeEventListener('keydown', swallow, true)
    window.removeEventListener('message', capture)
    controller.destroy()
  })

  it('armed but Shift+Enter → not blocked, no intent', async () => {
    const { editor } = buildComposer()
    const posted: unknown[] = []
    const capture = (e: MessageEvent): void => void posted.push(e.data)
    window.addEventListener('message', capture)

    const controller = createSendCapture({ win: window, origin: window.origin })
    controller.install()
    deliver(readyMessage)

    const event = new KeyboardEvent('keydown', {
      key: 'Enter',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
      composed: true,
    })
    editor.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    await new Promise((r) => setTimeout(r, 0))
    expect(posted.some(isSendIntent)).toBe(false)

    window.removeEventListener('message', capture)
    controller.destroy()
  })
})
