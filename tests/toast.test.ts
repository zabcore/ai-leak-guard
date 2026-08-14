// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { showToast } from '../src/content/toast'

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

// The toast renders into a closed Shadow DOM, so its internal buttons can't be
// introspected from the host page (by design). These cover the externally
// observable behavior; the close button is verified via manual testing.
//
// V1.1: the toast is a pure confirmation surface — no Undo button. The
// `onUndo` option was removed with the V1.1 Undo mechanism.
describe('showToast', () => {
  it('mounts a single host element into the document body', () => {
    showToast({ count: 1, labels: ['SSN'] })
    expect(document.body.childElementCount).toBe(1)
  })

  it('uses a closed shadow root the host page cannot read', () => {
    showToast({ count: 1, labels: ['SSN'] })
    expect(document.body.firstElementChild?.shadowRoot).toBeNull()
  })

  it('does not auto-dismiss after a delay (BUG A)', () => {
    vi.useFakeTimers()
    try {
      showToast({ count: 1, labels: ['SSN'] })
      vi.advanceTimersByTime(60_000)
      expect(document.body.childElementCount).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not schedule any timer in its lifecycle (BUG A)', () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    showToast({ count: 1, labels: ['SSN'] })
    expect(setTimeoutSpy).not.toHaveBeenCalled()
  })

  it('removes a stray toast host from another instance before mounting (BUG B)', () => {
    const stray = document.createElement('div')
    stray.setAttribute('data-ai-leak-guard-toast', '')
    document.body.appendChild(stray)

    showToast({ count: 1, labels: ['SSN'] })

    expect(document.body.childElementCount).toBe(1)
  })

  it('dismiss() removes the toast and invokes onDismiss', () => {
    const onDismiss = vi.fn()
    const handle = showToast({ count: 1, labels: ['SSN'], onDismiss })
    handle.dismiss()
    expect(document.body.childElementCount).toBe(0)
    expect(onDismiss).toHaveBeenCalledOnce()
  })

  it('replaces a previous toast so only one is visible at a time', () => {
    showToast({ count: 1, labels: ['SSN'] })
    showToast({ count: 2, labels: ['AWS Access Key', 'SSN'] })
    expect(document.body.childElementCount).toBe(1)
  })
})
