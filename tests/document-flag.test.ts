import { afterEach, describe, expect, it } from 'vitest'
import { isDocumentProtectionEnabled } from '../src/content/document-flag'

interface Override {
  __AI_LEAK_GUARD_DOC_FLAG__?: boolean
}

afterEach(() => {
  delete (globalThis as Override).__AI_LEAK_GUARD_DOC_FLAG__
})

describe('isDocumentProtectionEnabled — the flag-OFF byte-for-byte-behavior guard', () => {
  it('returns false by default (V1.2 ships with document protection OFF)', () => {
    // No override set — this is the shape a real V1.1.1 user sees.
    expect(isDocumentProtectionEnabled()).toBe(false)
  })

  it('honors an explicit `true` override for tests / future popup plumbing', () => {
    ;(globalThis as Override).__AI_LEAK_GUARD_DOC_FLAG__ = true
    expect(isDocumentProtectionEnabled()).toBe(true)
  })

  it('honors an explicit `false` override', () => {
    ;(globalThis as Override).__AI_LEAK_GUARD_DOC_FLAG__ = false
    expect(isDocumentProtectionEnabled()).toBe(false)
  })

  it('ignores non-boolean overrides (fails closed on misuse)', () => {
    ;(globalThis as unknown as { __AI_LEAK_GUARD_DOC_FLAG__: unknown }).__AI_LEAK_GUARD_DOC_FLAG__ =
      'yes'
    expect(isDocumentProtectionEnabled()).toBe(false)
  })

  it('re-reads on every call so a mid-session flip is honored by the next event', () => {
    expect(isDocumentProtectionEnabled()).toBe(false)
    ;(globalThis as Override).__AI_LEAK_GUARD_DOC_FLAG__ = true
    expect(isDocumentProtectionEnabled()).toBe(true)
    ;(globalThis as Override).__AI_LEAK_GUARD_DOC_FLAG__ = false
    expect(isDocumentProtectionEnabled()).toBe(false)
  })
})
