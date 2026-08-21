import { afterEach, describe, expect, it } from 'vitest'
import { isDocumentProtectionEnabled } from '../src/content/document-flag'

interface Override {
  __AI_LEAK_GUARD_DOC_FLAG__?: boolean
}

afterEach(() => {
  delete (globalThis as Override).__AI_LEAK_GUARD_DOC_FLAG__
})

describe('isDocumentProtectionEnabled — flag behavior', () => {
  it('returns true by default (V1.2 M6 GA ships with document protection ON)', () => {
    // No override set — this is what a real M6 user sees when the
    // extension loads. The A5.1 popup + full activity page + local
    // export are all live behind this default.
    expect(isDocumentProtectionEnabled()).toBe(true)
  })

  it('honors an explicit `false` override (kill switch for a broken site)', () => {
    // Kept as a runtime kill-switch so a future site regression can
    // be disabled without a new release. The A1 flag-OFF invariant
    // is what this covers — with the override false, the content
    // script must behave byte-for-byte like V1.1.1.
    ;(globalThis as Override).__AI_LEAK_GUARD_DOC_FLAG__ = false
    expect(isDocumentProtectionEnabled()).toBe(false)
  })

  it('honors an explicit `true` override', () => {
    ;(globalThis as Override).__AI_LEAK_GUARD_DOC_FLAG__ = true
    expect(isDocumentProtectionEnabled()).toBe(true)
  })

  it('ignores non-boolean overrides (falls back to the compile-time default)', () => {
    ;(globalThis as unknown as { __AI_LEAK_GUARD_DOC_FLAG__: unknown }).__AI_LEAK_GUARD_DOC_FLAG__ =
      'yes'
    // Compile-time default is now `true`, so a garbage-typed
    // override falls back to on. Same rule as before, different
    // default — an unrecognised override never surprises us.
    expect(isDocumentProtectionEnabled()).toBe(true)
  })

  it('re-reads on every call so a mid-session flip is honored by the next event', () => {
    expect(isDocumentProtectionEnabled()).toBe(true)
    ;(globalThis as Override).__AI_LEAK_GUARD_DOC_FLAG__ = false
    expect(isDocumentProtectionEnabled()).toBe(false)
    ;(globalThis as Override).__AI_LEAK_GUARD_DOC_FLAG__ = true
    expect(isDocumentProtectionEnabled()).toBe(true)
  })
})
