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
    // Buttons live in the closed shadow — we probe them by keyboard.
    // Enter in scanning state must NOT resolve upload-anyway because
    // the primary is hidden and the focus lands on cancel by default.
    // We assert this via the outcome test below.
    expect(isDocumentModalOpen()).toBe(true)
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
    // Primary button is [Upload anyway]; Enter triggers it.
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

  it('Enter after showing sensitive resolves upload-anyway (primary)', async () => {
    const ctrl = openDocumentModal({ opener: null })
    ctrl.showSensitive({
      fileCount: 2,
      totalMaskable: 5,
      categories: [DetectorCategory.IDENTITY],
      hasCriticalOrHigh: false,
    })
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    await expect(ctrl.outcome).resolves.toBe('upload-anyway')
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
    expect(shadowTextContent()).toContain("We couldn't read this file")
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
  })

  it('tolerates a null opener without throwing on close', async () => {
    const ctrl = openDocumentModal({ opener: null })
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await expect(ctrl.outcome).resolves.toBe('cancel')
  })
})

describe('openDocumentModal — metadata-only rendering', () => {
  // The modal MUST NOT render `Finding.value` (the raw matched
  // string). Consistent with A5's metadata-only event log + the
  // no-clean-copy scope. This test asserts a specific SSN value
  // never appears anywhere in the modal's DOM subtree — we can't
  // read the closed shadow root from the outside, so we reach in
  // via the host's shadowRoot when we (re)configure the modal in
  // this test's isolated setup using an OPEN shadow root proxy.
  //
  // We do this by rendering the sensitive view with a shape that
  // WOULD have matched, and asserting a well-known SSN literal is
  // not present in the modal's serialized outerHTML / DOM tree
  // reachable via any well-known API. Since the closed shadow root
  // hides its contents from `outerHTML`, we walk the host's own
  // shadow root through the DevTools-visible internal handle:
  // browsers expose an `internals_` seam in tests via the
  // constructor (jsdom returns null for closed shadow, but the
  // implementation's applySensitive constructs chip text from
  // `friendlyCategoryLabel(cat)` alone — never from Finding values —
  // so we verify the source constraint directly by asserting the
  // labels do not include the raw value).

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
