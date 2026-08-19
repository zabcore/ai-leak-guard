// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  __resetDocumentModalForTests,
  isDocumentModalOpen,
  showDocumentModal,
} from '../src/content/document-modal'

afterEach(() => {
  __resetDocumentModalForTests()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('showDocumentModal — mount + isolation', () => {
  it('mounts exactly one host element into the document body', () => {
    void showDocumentModal({ fileCount: 1, opener: null })
    expect(document.body.childElementCount).toBe(1)
    expect(isDocumentModalOpen()).toBe(true)
  })

  it('uses a closed shadow root the host page cannot read', () => {
    void showDocumentModal({ fileCount: 1, opener: null })
    expect(document.body.firstElementChild?.shadowRoot).toBeNull()
  })

  it('a second call while one is open resolves as cancel WITHOUT opening another', async () => {
    const first = showDocumentModal({ fileCount: 1, opener: null })
    const before = document.body.childElementCount
    const second = await showDocumentModal({ fileCount: 1, opener: null })
    expect(second).toBe('cancel')
    expect(document.body.childElementCount).toBe(before)
    expect(isDocumentModalOpen()).toBe(true)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await first
  })
})

describe('showDocumentModal — outcomes', () => {
  it('Escape resolves with cancel and removes the host', async () => {
    const promise = showDocumentModal({ fileCount: 1, opener: null })
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    const outcome = await promise
    expect(outcome).toBe('cancel')
    expect(document.body.childElementCount).toBe(0)
    expect(isDocumentModalOpen()).toBe(false)
  })

  it('Enter resolves with upload-anyway (primary action)', async () => {
    const promise = showDocumentModal({ fileCount: 2, opener: null })
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    const outcome = await promise
    expect(outcome).toBe('upload-anyway')
  })
})

describe('showDocumentModal — focus behavior', () => {
  it('returns focus to the opener element on close', async () => {
    const opener = document.createElement('textarea')
    document.body.appendChild(opener)
    opener.focus()
    const promise = showDocumentModal({ fileCount: 1, opener })
    // Focus is inside the modal now.
    expect(document.activeElement).not.toBe(opener)

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await promise

    expect(document.activeElement).toBe(opener)
  })

  it('tolerates a null opener without throwing on close', async () => {
    const promise = showDocumentModal({ fileCount: 1, opener: null })
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await expect(promise).resolves.toBe('cancel')
  })
})
