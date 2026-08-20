// @vitest-environment jsdom
//
// V1.2 A4 modal component tests. The modal is a controller with
// three view states (scanning / sensitive / unable) that the shared
// decision helper transitions through. These tests exercise each
// state's DOM + a11y behavior, the Enter/Escape/Tab focus trap in
// the presence of a hidden primary button (scanning state), the
// close-during-scanning short circuit, and — most importantly —
// the metadata-only invariant: raw `Finding.value` matches never
// appear in the modal's shadow DOM.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { DetectorCategory } from '../src/detector/types'
import {
  __getModalShadowForTests,
  __resetDocumentModalForTests,
  friendlyCategoryLabel,
  isDocumentModalOpen,
  openDocumentModal,
} from '../src/content/document-modal'

afterEach(() => {
  __resetDocumentModalForTests()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

function shadowTextContent(): string {
  // Reach into the closed shadow root via the module's test seam.
  // Never available in production — production callers see `null` on
  // `host.shadowRoot`.
  return __getModalShadowForTests()?.textContent ?? ''
}

describe('openDocumentModal — mount + isolation', () => {
  it('mounts exactly one host element and starts in the scanning state', () => {
    openDocumentModal({ opener: null })
    expect(document.body.childElementCount).toBe(1)
    expect(isDocumentModalOpen()).toBe(true)
    // Closed shadow — host.shadowRoot is null from the outside.
    const host = document.body.firstElementChild as HTMLElement
    expect(host.shadowRoot).toBeNull()
    // The scanning copy IS rendered inside the closed shadow — the
    // test seam reaches in.
    expect(shadowTextContent()).toContain('Checking this file')
  })

  it('a second call while one is open resolves cancel WITHOUT opening another', async () => {
    const first = openDocumentModal({ opener: null })
    const before = document.body.childElementCount
    const second = openDocumentModal({ opener: null })
    expect(document.body.childElementCount).toBe(before)
    expect(isDocumentModalOpen()).toBe(true)
    await expect(second.outcome).resolves.toBe('cancel')
    first.close('cancel')
    await first.outcome
  })
})

describe('openDocumentModal — scanning state', () => {
  it('primary button (Upload anyway) is hidden during scanning', () => {
    openDocumentModal({ opener: null })
    expect(isDocumentModalOpen()).toBe(true)
    const shadow = __getModalShadowForTests()
    const primary = shadow?.querySelector('.btn--primary') as HTMLButtonElement | null
    const secondary = shadow?.querySelector('.btn--secondary') as HTMLButtonElement | null
    expect(primary).not.toBeNull()
    // Direct DOM assertion — the seam gives us the closed shadow root
    // so we don't have to infer visibility from downstream behavior.
    expect(primary?.hidden).toBe(true)
    // Sanity: [Cancel] stays visible so the user can bail during the
    // scan.
    expect(secondary?.hidden).toBe(false)
  })

  it('Enter during scanning does not resolve upload-anyway', async () => {
    const ctrl = openDocumentModal({ opener: null })
    // Focus is on Cancel per applyScanning; Enter on cancel is a no-op
    // in the shadow root (browser would activate the focused button,
    // but our keyHandler only stopPropagations for that branch).
    // We verify by racing: no resolution within a microtask.
    let settled = false
    void ctrl.outcome.then(() => {
      settled = true
    })
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    await Promise.resolve()
    expect(settled).toBe(false)
    ctrl.close('cancel')
    await ctrl.outcome
  })

  it('Escape during scanning resolves cancel and removes the host', async () => {
    const ctrl = openDocumentModal({ opener: null })
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await expect(ctrl.outcome).resolves.toBe('cancel')
    expect(document.body.childElementCount).toBe(0)
    expect(isDocumentModalOpen()).toBe(false)
  })
})

describe('openDocumentModal — sensitive state', () => {
  it('renders count + friendly category chips', async () => {
    const ctrl = openDocumentModal({ opener: null })
    ctrl.showSensitive({
      fileCount: 1,
      totalMaskable: 3,
      categories: [DetectorCategory.HEALTHCARE_PATIENT_ID, DetectorCategory.GOVERNMENT_FINANCIAL],
      hasCriticalOrHigh: true,
    })
    const text = shadowTextContent()
    // Count + noun-agreement, both category chip labels, and the
    // critical-or-high emphasis line all rendered.
    expect(text).toContain('3 sensitive items found')
    expect(text).toContain(friendlyCategoryLabel(DetectorCategory.HEALTHCARE_PATIENT_ID))
    expect(text).toContain(friendlyCategoryLabel(DetectorCategory.GOVERNMENT_FINANCIAL))
    expect(text).toContain('high-severity')
    // Focus lands on the dialog container after the scanning → sensitive
    // transition — an intentional safety change so a held Enter can't
    // release before the user reads the warning. Tab explicitly moves
    // to [Upload anyway], then Enter triggers it.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }))
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    await expect(ctrl.outcome).resolves.toBe('upload-anyway')
  })

  it('multi-file headline aggregates across files', () => {
    const ctrl = openDocumentModal({ opener: null })
    ctrl.showSensitive({
      fileCount: 3,
      totalMaskable: 5,
      categories: [DetectorCategory.IDENTITY],
      hasCriticalOrHigh: false,
    })
    expect(shadowTextContent()).toContain('5 sensitive items found across 3 files')
    // No critical/high — no severity line.
    expect(shadowTextContent()).not.toContain('high-severity')
    ctrl.close('cancel')
    return ctrl.outcome
  })

  it('Tab-then-Enter after showing sensitive resolves upload-anyway (primary)', async () => {
    const ctrl = openDocumentModal({ opener: null })
    ctrl.showSensitive({
      fileCount: 2,
      totalMaskable: 5,
      categories: [DetectorCategory.IDENTITY],
      hasCriticalOrHigh: false,
    })
    // Transition focuses `dialog`; a Tab moves focus to [Upload anyway]
    // (list[0] in the trap), then Enter finalizes.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }))
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    await expect(ctrl.outcome).resolves.toBe('upload-anyway')
  })

  it('bare Enter after showing sensitive does NOT resolve upload-anyway (held-Enter safety)', async () => {
    // Focus-safety invariant: a user holding Enter (e.g., trying to
    // send a prompt on ChatGPT) when the scanning view flips to
    // sensitive must not accidentally release the file. The transition
    // focuses the dialog container, and the Enter recovery pulls focus
    // back to Cancel — so a single Enter is a no-op, never a release.
    const ctrl = openDocumentModal({ opener: null })
    ctrl.showSensitive({
      fileCount: 1,
      totalMaskable: 2,
      categories: [DetectorCategory.HEALTHCARE_PATIENT_ID],
      hasCriticalOrHigh: true,
    })
    let settled = false
    void ctrl.outcome.then(() => {
      settled = true
    })
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    await Promise.resolve()
    expect(settled).toBe(false)
    ctrl.close('cancel')
    await ctrl.outcome
  })

  it('Escape after showing sensitive resolves cancel', async () => {
    const ctrl = openDocumentModal({ opener: null })
    ctrl.showSensitive({
      fileCount: 1,
      totalMaskable: 1,
      categories: [DetectorCategory.GOVERNMENT_FINANCIAL],
      hasCriticalOrHigh: true,
    })
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await expect(ctrl.outcome).resolves.toBe('cancel')
  })
})

describe('openDocumentModal — unable state', () => {
  it('renders a reason-aware sub-line for encrypted files', async () => {
    const ctrl = openDocumentModal({ opener: null })
    ctrl.showUnable({ fileCount: 1, reason: 'encrypted' })
    expect(shadowTextContent()).toContain("We couldn't read this file")
    expect(shadowTextContent()).toContain('password-protected')
    // Same held-Enter safety as the sensitive path — Tab first, then
    // Enter finalizes upload-anyway.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }))
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    await expect(ctrl.outcome).resolves.toBe('upload-anyway')
  })

  it('renders a reason-aware sub-line for no-text-layer (scanned image PDFs)', () => {
    const ctrl = openDocumentModal({ opener: null })
    ctrl.showUnable({ fileCount: 1, reason: 'no-text-layer' })
    expect(shadowTextContent()).toContain('scanned image')
    ctrl.close('cancel')
    return ctrl.outcome
  })

  it('multi-file unable headline is pluralised', () => {
    const ctrl = openDocumentModal({ opener: null })
    ctrl.showUnable({ fileCount: 3, reason: 'too-large' })
    expect(shadowTextContent()).toContain('one or more files')
    expect(shadowTextContent()).toContain('too large')
    ctrl.close('cancel')
    return ctrl.outcome
  })

  it('renders a fallback sub-line when reason is missing', async () => {
    const ctrl = openDocumentModal({ opener: null })
    ctrl.showUnable({ fileCount: 1 })
    // Match the body-specific fallback ("…to check its contents.")
    // rather than the shared heading — otherwise the assertion would
    // pass even if `unableReasonLine` silently returned an empty
    // string.
    expect(shadowTextContent()).toContain('check its contents')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await expect(ctrl.outcome).resolves.toBe('cancel')
  })
})

describe('openDocumentModal — controller programmatic close', () => {
  it('close(upload-anyway) resolves upload-anyway without user interaction', async () => {
    const ctrl = openDocumentModal({ opener: null })
    ctrl.close('upload-anyway')
    await expect(ctrl.outcome).resolves.toBe('upload-anyway')
    expect(document.body.childElementCount).toBe(0)
    expect(isDocumentModalOpen()).toBe(false)
  })

  it('close is idempotent — second call is a no-op', async () => {
    const ctrl = openDocumentModal({ opener: null })
    ctrl.close('upload-anyway')
    ctrl.close('cancel')
    await expect(ctrl.outcome).resolves.toBe('upload-anyway')
  })
})

describe('openDocumentModal — focus behavior', () => {
  it('returns focus to the opener element on close', async () => {
    const opener = document.createElement('textarea')
    document.body.appendChild(opener)
    opener.focus()
    const ctrl = openDocumentModal({ opener })
    // Focus is inside the modal now.
    expect(document.activeElement).not.toBe(opener)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await ctrl.outcome
    expect(document.activeElement).toBe(opener)
    // Clean up the opener we appended so later tests that assert on
    // `document.body.childElementCount` see a fresh body.
    opener.remove()
  })

  it('tolerates a null opener without throwing on close', async () => {
    const ctrl = openDocumentModal({ opener: null })
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await expect(ctrl.outcome).resolves.toBe('cancel')
  })
})

describe('openDocumentModal — metadata-only rendering', () => {
  // The modal MUST NOT render `Finding.value` (the raw matched
  // string). Consistent with A5's metadata-only event log and the
  // no-clean-copy scope.
  //
  // The host uses a closed shadow root, so `host.shadowRoot` is null
  // from the outside. These tests read the rendered subtree through
  // the module's `__getModalShadowForTests` seam and assert that
  // known secret literals are absent while the expected metadata
  // copy is present.

  it('friendlyCategoryLabel is metadata-only — does not echo raw match input', () => {
    // The chip factory only accepts a DetectorCategory enum member
    // and returns a fixed friendly label; there is no path for a
    // raw Finding.value to influence the label. This is the
    // source-level enforcement of the metadata-only invariant.
    const label = friendlyCategoryLabel(DetectorCategory.GOVERNMENT_FINANCIAL)
    expect(label).toBe('SSN / financial')
    expect(label).not.toContain('123-45-6789')
  })

  it('sensitive view: raw Finding.value string is never present in the shadow DOM', () => {
    const ctrl = openDocumentModal({ opener: null })
    ctrl.showSensitive({
      fileCount: 1,
      totalMaskable: 1,
      categories: [DetectorCategory.GOVERNMENT_FINANCIAL],
      hasCriticalOrHigh: true,
    })
    // A well-known SSN literal that a real finding would carry. The
    // modal only receives counts + categories on its API surface,
    // so the value should never appear in the rendered shadow DOM.
    const secret = '123-45-6789'
    const shadowText = shadowTextContent()
    expect(shadowText).not.toContain(secret)
    // And a general no-digits-echo sanity check: a raw ID string
    // like "9876543210" is not surfaced either.
    expect(shadowText).not.toContain('9876543210')
    // Meanwhile the metadata-only content IS present.
    expect(shadowText).toContain('1 sensitive item found')
    ctrl.close('cancel')
    return ctrl.outcome
  })

  it('unable view: reason enum is honest, does not echo the raw filename or bytes', () => {
    const ctrl = openDocumentModal({ opener: null })
    ctrl.showUnable({ fileCount: 1, reason: 'encrypted' })
    const shadowText = shadowTextContent()
    // The unable view only receives fileCount + reason — no file
    // names, no raw bytes, no MIME details from the extractor.
    expect(shadowText).not.toContain('.pdf')
    expect(shadowText).not.toContain('encrypted') // reason enum is
    // not surfaced as the raw enum key; the copy is friendly.
    ctrl.close('cancel')
    return ctrl.outcome
  })
})
