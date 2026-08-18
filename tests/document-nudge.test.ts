// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { __resetNudgeForTests, showReattachNudge } from '../src/content/document-nudge'

afterEach(() => {
  __resetNudgeForTests()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

/**
 * The nudge is rendered into a `closed` shadow root, so its internals
 * are not reachable via `host.shadowRoot`. To assert what's actually
 * inside, we spy on `Element.attachShadow` to capture the ShadowRoot
 * reference at construction time — the same technique the preview /
 * document modal component tests use.
 */
function captureNextShadowRoot(): { readonly get: () => ShadowRoot | null } {
  let captured: ShadowRoot | null = null
  const original = Element.prototype.attachShadow
  vi.spyOn(Element.prototype, 'attachShadow').mockImplementation(function (
    this: Element,
    init: ShadowRootInit,
  ) {
    const root = original.call(this, init)
    if (captured === null) captured = root
    return root
  })
  return {
    get: () => captured,
  }
}

describe('showReattachNudge', () => {
  it('mounts exactly one host element with a closed shadow root', () => {
    showReattachNudge('Please re-attach.')
    expect(document.body.childElementCount).toBe(1)
    expect(document.body.firstElementChild?.shadowRoot).toBeNull()
  })

  it('replaces a prior nudge instead of stacking', () => {
    showReattachNudge('First message.')
    showReattachNudge('Second message.')
    expect(document.body.childElementCount).toBe(1)
  })

  it('removes stray nudge hosts from a previous content-script instance before mounting', () => {
    const stray = document.createElement('div')
    stray.setAttribute('data-ai-leak-guard-document-nudge', '')
    document.body.appendChild(stray)
    showReattachNudge('Post-instance.')
    expect(document.body.childElementCount).toBe(1)
  })

  it('renders the caller-supplied message verbatim into the .nudge__text element', () => {
    const spy = captureNextShadowRoot()
    showReattachNudge('Attachment released. Please pick the file again.')
    const root = spy.get()
    expect(root).not.toBeNull()
    const text = root?.querySelector('.nudge__text')
    expect(text?.textContent).toBe('Attachment released. Please pick the file again.')
  })

  it('renders each subsequent message in the new shadow root when replaced', () => {
    // First mount — capture its root, then a second call replaces it
    // (host count stays 1); the second root should carry the new
    // message. Uses two independent captures.
    const first = captureNextShadowRoot()
    showReattachNudge('First message.')
    expect(first.get()?.querySelector('.nudge__text')?.textContent).toBe('First message.')

    vi.restoreAllMocks()
    const second = captureNextShadowRoot()
    showReattachNudge('Second message.')
    expect(second.get()?.querySelector('.nudge__text')?.textContent).toBe('Second message.')
    expect(document.body.childElementCount).toBe(1)
  })

  it('clicking the .nudge__close button removes the host from the DOM', () => {
    const spy = captureNextShadowRoot()
    showReattachNudge('Dismiss me.')
    const root = spy.get()
    const close = root?.querySelector('.nudge__close') as HTMLButtonElement | null
    expect(close).not.toBeNull()
    close?.click()
    expect(document.body.childElementCount).toBe(0)
  })
})
