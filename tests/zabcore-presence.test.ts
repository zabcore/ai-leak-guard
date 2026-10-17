// Teams Lite — bridge/1.1.0 presence hint (C3): the content script on
// https://zabcore.com/join* posts {ns, v, type:"cs_presence", payload:{ext_version}}
// once on load, to the zabcore origin only.

import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { PRESENCE_ORIGIN, announcePresence, presenceHint } from '../src/content/zabcore-presence'

function fakeWindow(url: string, opts: { readyState?: string; top?: 'self' | 'other' } = {}) {
  const u = new URL(url)
  const listeners: Record<string, Array<() => void>> = {}
  const win = {
    location: { origin: u.origin, pathname: u.pathname },
    document: { readyState: opts.readyState ?? 'complete' },
    postMessage: vi.fn(),
    addEventListener: vi.fn((type: string, fn: () => void) => {
      ;(listeners[type] ??= []).push(fn)
    }),
    top: null as unknown,
  }
  win.top = opts.top === 'other' ? {} : win
  return {
    win: win as unknown as Window & typeof win,
    fire: (t: string) => listeners[t]?.forEach((f) => f()),
  }
}

describe('cs_presence hint', () => {
  it('has exactly the contract shape', () => {
    expect(presenceHint('1.3.6')).toEqual({
      ns: 'zc.join',
      v: 1,
      type: 'cs_presence',
      payload: { ext_version: '1.3.6' },
    })
  })

  it('posts once, to the zabcore origin, when the page is already loaded', () => {
    const { win } = fakeWindow('https://zabcore.com/join?inv=1')
    expect(announcePresence(win, '1.3.6')).toBe(true)
    expect(win.postMessage).toHaveBeenCalledTimes(1)
    expect(win.postMessage).toHaveBeenCalledWith(presenceHint('1.3.6'), PRESENCE_ORIGIN)
  })

  it('waits for load when the page is still loading, then posts once', () => {
    const { win, fire } = fakeWindow('https://zabcore.com/join', { readyState: 'interactive' })
    announcePresence(win, '1.3.6')
    expect(win.postMessage).not.toHaveBeenCalled()
    expect(win.addEventListener).toHaveBeenCalledWith('load', expect.any(Function), { once: true })
    fire('load')
    expect(win.postMessage).toHaveBeenCalledTimes(1)
    expect(win.postMessage).toHaveBeenCalledWith(presenceHint('1.3.6'), 'https://zabcore.com')
  })

  it.each([
    ['another origin', 'https://evil.example/join'],
    ['www', 'https://www.zabcore.com/join'],
    ['not a join page', 'https://zabcore.com/pricing'],
  ])('posts nothing on %s', (_l, url) => {
    const { win } = fakeWindow(url)
    expect(announcePresence(win, '1.3.6')).toBe(false)
    expect(win.postMessage).not.toHaveBeenCalled()
  })

  it('posts nothing from a sub-frame', () => {
    const { win } = fakeWindow('https://zabcore.com/join', { top: 'other' })
    expect(announcePresence(win, '1.3.6')).toBe(false)
    expect(win.postMessage).not.toHaveBeenCalled()
  })

  it('is injected by the manifest on the apex join pages only, top frame, after load', () => {
    const manifest = JSON.parse(readFileSync('manifest.json', 'utf8')) as {
      content_scripts: Array<{
        matches: string[]
        js: string[]
        run_at?: string
        all_frames?: boolean
      }>
    }
    const entry = manifest.content_scripts.find((c) =>
      c.js.includes('src/content/zabcore-presence.ts'),
    )
    expect(entry).toEqual({
      matches: ['https://zabcore.com/join*'],
      js: ['src/content/zabcore-presence.ts'],
      run_at: 'document_idle',
      all_frames: false,
    })
  })

  it('the script does nothing else: no network, storage, messaging or listeners', () => {
    const src = readFileSync('src/content/zabcore-presence.ts', 'utf8').replace(/\/\/.*$/gm, '')
    for (const forbidden of [
      'fetch(',
      'XMLHttpRequest',
      'chrome.storage',
      'sendMessage',
      'connect(',
      "addEventListener('message'",
    ]) {
      expect(src).not.toContain(forbidden)
    }
  })
})
