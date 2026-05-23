import { describe, it, expect } from 'vitest'
import { resolveInitialEnabled } from '../src/content/enabled-state'

describe('resolveInitialEnabled', () => {
  it('returns true when the stored preference is enabled', async () => {
    expect(await resolveInitialEnabled(async () => ({ enabled: true }))).toBe(true)
  })

  it('returns false when the stored preference is disabled', async () => {
    expect(await resolveInitialEnabled(async () => ({ enabled: false }))).toBe(false)
  })

  it('fails closed (false) when the preference read rejects', async () => {
    expect(
      await resolveInitialEnabled(() => Promise.reject(new Error('storage unavailable'))),
    ).toBe(false)
  })
})
