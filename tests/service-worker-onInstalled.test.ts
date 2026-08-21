// V1.2 M6 onInstalled welcome-tab unit test.
//
// Pins the two invariants the release depends on:
//   • On `reason: 'install'` — call `chrome.tabs.create` exactly
//     once with the versioned zabcore.com welcome URL.
//   • On any other reason (`'update'`, `'chrome_update'`, or a
//     future value like `'shared_module_update'`) — do nothing,
//     so a Chrome Web Store extension update doesn't spam the
//     user with a welcome tab every release.
//
// The handler is exported from the SW module for direct exercise
// (calling the anonymous `chrome.runtime.onInstalled.addListener`
// callback from a test would require capturing the listener via
// the setup-shim; the exported seam is cleaner).

import { describe, expect, it, vi } from 'vitest'
import { handleInstalled, WELCOME_URL } from '../src/background/service-worker'

describe('service-worker — onInstalled welcome tab (M6)', () => {
  it('opens the /welcome URL once on install', () => {
    const create = vi.fn()
    handleInstalled({ reason: 'install' }, { create })
    expect(create).toHaveBeenCalledTimes(1)
    expect(create).toHaveBeenCalledWith({ url: WELCOME_URL })
    // Pin the URL shape — this is the Chrome Web Store attribution
    // + campaign we quote in the launch write-up, so a silent
    // drift on any of these params should break the test.
    const url = create.mock.calls[0][0].url as string
    expect(url).toContain('zabcore.com/welcome')
    expect(url).toContain('src=chrome_web_store')
    expect(url).toContain('utm_source=chrome_web_store')
    expect(url).toContain('utm_medium=extension')
    expect(url).toContain('utm_campaign=install_v1_2')
    expect(url).toContain('v=1.2')
  })

  it('does nothing on update — no welcome-tab spam per release', () => {
    const create = vi.fn()
    handleInstalled({ reason: 'update' }, { create })
    expect(create).not.toHaveBeenCalled()
  })

  it('does nothing on chrome_update (browser upgrade, not our install)', () => {
    const create = vi.fn()
    handleInstalled({ reason: 'chrome_update' }, { create })
    expect(create).not.toHaveBeenCalled()
  })

  it('does nothing on any unknown reason (fail-closed)', () => {
    const create = vi.fn()
    handleInstalled({ reason: 'shared_module_update' }, { create })
    handleInstalled({ reason: 'anything-else' }, { create })
    expect(create).not.toHaveBeenCalled()
  })

  it('degrades gracefully when chrome.tabs is unavailable', () => {
    // Belt-and-braces — if `chrome.tabs` is absent (rare, but
    // some managed contexts strip it), the handler should be a
    // silent no-op instead of throwing and taking down the SW.
    expect(() => handleInstalled({ reason: 'install' }, undefined)).not.toThrow()
  })

  it('swallows a rejected tabs.create Promise (no unhandled rejection)', async () => {
    // `chrome.tabs.create` returns Promise<Tab> in MV3; a rejection
    // (e.g., corporate managed browser blocking new tabs) must be
    // caught so it never leaks into an unhandled rejection.
    const create = vi.fn(() => Promise.reject(new Error('managed policy')))
    handleInstalled({ reason: 'install' }, { create })
    // Give the microtask queue a chance to run the .catch handler.
    await Promise.resolve()
    await Promise.resolve()
    expect(create).toHaveBeenCalledTimes(1)
    // If the .catch didn't run, vitest's unhandledRejection guard
    // would fail the test here.
  })
})
