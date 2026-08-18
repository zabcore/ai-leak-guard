// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { __resetNudgeForTests, showReattachNudge } from '../src/content/document-nudge'

afterEach(() => {
  __resetNudgeForTests()
  document.body.innerHTML = ''
})

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
})
