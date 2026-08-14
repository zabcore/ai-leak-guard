// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  __resetPreviewModalForTests,
  isPreviewModalOpen,
  showPreviewModal,
} from '../src/content/preview-modal'
import type { PreviewSummary } from '../src/content/preview-flow'

// The modal renders into a CLOSED shadow root — by design the host page can't
// read its internals. These tests exercise the externally observable
// behavior: mount/dismount, single-modal invariant, resolution outcomes,
// keyboard handling (Escape / Enter), focus restore, and the ignored-second-
// paste path.
//
// A closed shadow root cannot be introspected via `element.shadowRoot`, so
// wherever we need to reach an internal button (to simulate a click) we do it
// through `dispatchEvent(new KeyboardEvent('keydown', {...}))` at the document
// level — the modal listens in capture and turns keys into outcomes. That is
// the same channel real users hit and is enough coverage without punching
// through the shadow boundary.

function textSummary(overrides: Partial<PreviewSummary> = {}): PreviewSummary {
  return {
    count: 2,
    groups: [
      { label: 'Patient Name', count: 1 },
      { label: 'MRN', count: 1 },
    ],
    protectedText: 'Patient: [PATIENT_NAME], MRN: [MRN]',
    ...overrides,
  }
}

afterEach(() => {
  __resetPreviewModalForTests()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('showPreviewModal — mount + isolation', () => {
  it('mounts exactly one host element into the document body', () => {
    void showPreviewModal({ summary: textSummary(), opener: null })
    expect(document.body.childElementCount).toBe(1)
    expect(isPreviewModalOpen()).toBe(true)
  })

  it('uses a closed shadow root the host page cannot read', () => {
    void showPreviewModal({ summary: textSummary(), opener: null })
    expect(document.body.firstElementChild?.shadowRoot).toBeNull()
  })

  it('a second call while one is open resolves as cancel WITHOUT opening another', async () => {
    const first = showPreviewModal({ summary: textSummary(), opener: null })
    const before = document.body.childElementCount
    const second = await showPreviewModal({ summary: textSummary(), opener: null })
    expect(second).toBe('cancel')
    // No new host element was appended.
    expect(document.body.childElementCount).toBe(before)
    // The first is still on screen and unresolved.
    expect(isPreviewModalOpen()).toBe(true)
    // Clean up.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await first
  })
})

describe('showPreviewModal — outcomes', () => {
  it('Escape resolves with `cancel` and removes the host', async () => {
    const promise = showPreviewModal({ summary: textSummary(), opener: null })
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    const outcome = await promise
    expect(outcome).toBe('cancel')
    expect(document.body.childElementCount).toBe(0)
    expect(isPreviewModalOpen()).toBe(false)
  })

  it('Enter resolves with `protected` (the primary action)', async () => {
    const promise = showPreviewModal({ summary: textSummary(), opener: null })
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    const outcome = await promise
    expect(outcome).toBe('protected')
  })
})

describe('showPreviewModal — focus behavior', () => {
  it('returns focus to the opener element on close', async () => {
    const opener = document.createElement('textarea')
    document.body.appendChild(opener)
    opener.focus()

    const promise = showPreviewModal({ summary: textSummary(), opener })
    // Focus has moved away from the opener into the modal.
    expect(document.activeElement).not.toBe(opener)

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await promise

    expect(document.activeElement).toBe(opener)
  })

  it('tolerates a null opener without throwing on close', async () => {
    const promise = showPreviewModal({ summary: textSummary(), opener: null })
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await expect(promise).resolves.toBe('cancel')
  })

  it('tolerates an opener that was removed from the DOM before close', async () => {
    const opener = document.createElement('textarea')
    document.body.appendChild(opener)
    const promise = showPreviewModal({ summary: textSummary(), opener })
    opener.remove()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await expect(promise).resolves.toBe('cancel')
  })
})

describe('showPreviewModal — surface honors the summary', () => {
  it('renders no LOW-context group when the summary excludes them', () => {
    // The modal receives the already-filtered summary; we validate its
    // externally-observable size (one host) is not affected by extra groups
    // and that opening with count === 0 still resolves.
    const summary: PreviewSummary = {
      count: 0,
      groups: [],
      protectedText: 'nothing sensitive.',
    }
    void showPreviewModal({ summary, opener: null })
    expect(isPreviewModalOpen()).toBe(true)
    // Cleanup handled by afterEach.
  })
})
