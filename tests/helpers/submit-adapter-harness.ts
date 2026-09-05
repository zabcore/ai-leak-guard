// @vitest-environment jsdom
//
// Shared jsdom harness for the V1.3 M3 Claude + Gemini submit-adapter
// suites. The ChatGPT suite (M2) is deliberately NOT refactored to use
// this — it stays self-contained as the regression proof that the M3
// base-class extraction preserved behaviour.

import {
  SubmitCore,
  type ScanOutcome,
  type SubmitCoreDeps,
} from '../../src/content/submit/submit-core'

export interface Harness {
  /** The element the adapter's composer selector should resolve to. */
  composer: HTMLElement
  button: HTMLButtonElement
  setComposerHtml: (html: string) => void
  cleanup: () => void
}

/** Controllable decision seam: records calls, resolves on demand. */
export function controllableDecide() {
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

export function makeCore(overrides: Partial<SubmitCoreDeps> = {}): SubmitCore {
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

/** Dispatch a capture-phase-observable keydown from `el`. */
export function pressEnter(
  el: HTMLElement,
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
  el.focus()
  el.dispatchEvent(event)
  return event
}

export async function flush(n = 8): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

export const SSN_TEXT = 'Patient SSN is 123-45-6789'
export const CLEAN_TEXT = 'What is the capital of France?'

export type { ScanOutcome }
