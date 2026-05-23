// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { showToast } from '../src/content/toast'

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

// The toast renders into a closed Shadow DOM, so its internal buttons can't be
// introspected from the host page (by design). These cover the externally
// observable behavior; Undo/×/error click handling is verified via the manual
// test plan.
describe('showToast', () => {
  it('mounts a single host element into the document body', () => {
    showToast({ count: 1, labels: ['SSN'], onUndo: () => true })
    expect(document.body.childElementCount).toBe(1)
  })

  it('uses a closed shadow root the host page cannot read', () => {
    showToast({ count: 1, labels: ['SSN'], onUndo: () => true })
    expect(document.body.firstElementChild?.shadowRoot).toBeNull()
  })

  it('does not auto-dismiss after a delay', () => {
    vi.useFakeTimers()
    try {
      showToast({ count: 1, labels: ['SSN'], onUndo: () => true })
      vi.advanceTimersByTime(60_000)
      expect(document.body.childElementCount).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('dismiss() removes the toast and invokes onDismiss', () => {
    const onDismiss = vi.fn()
    const handle = showToast({ count: 1, labels: ['SSN'], onUndo: () => true, onDismiss })
    handle.dismiss()
    expect(document.body.childElementCount).toBe(0)
    expect(onDismiss).toHaveBeenCalledOnce()
  })

  it('replaces a previous toast so only one is visible at a time', () => {
    showToast({ count: 1, labels: ['SSN'], onUndo: () => true })
    showToast({ count: 2, labels: ['AWS Access Key', 'SSN'], onUndo: () => true })
    expect(document.body.childElementCount).toBe(1)
  })
})
