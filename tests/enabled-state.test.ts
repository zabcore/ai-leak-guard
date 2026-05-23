import { describe, it, expect } from 'vitest'
import { resolveInitialEnabled, createEnabledState } from '../src/content/enabled-state'

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

describe('createEnabledState', () => {
  it('defaults to the provided initial value', () => {
    expect(createEnabledState(false).isEnabled()).toBe(false)
    expect(createEnabledState(true).isEnabled()).toBe(true)
  })

  it('applies the initial read when no live update has happened', () => {
    const state = createEnabledState(false)
    state.applyInitial(true)
    expect(state.isEnabled()).toBe(true)
  })

  it('lets a live update that arrives before the initial read win', () => {
    const state = createEnabledState(false)
    // User toggles the popup during startup — onChanged fires first.
    state.applyLiveUpdate(true)
    // The slower initial storage read then resolves with the stale value.
    state.applyInitial(false)
    expect(state.isEnabled()).toBe(true)
  })

  it('applies live updates that arrive after the initial read', () => {
    const state = createEnabledState(false)
    state.applyInitial(true)
    state.applyLiveUpdate(false)
    expect(state.isEnabled()).toBe(false)
  })
})
