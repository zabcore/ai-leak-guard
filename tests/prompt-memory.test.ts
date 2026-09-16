// V1.3.3 Onboarding — the dismissible-nudge memory must remember "Not now"
// (snooze) and "Don't ask again" (never) LOCALLY. Pure unit coverage of the
// decision logic; the chrome.storage.local wrappers are in storage.ts.

import { describe, expect, it } from 'vitest'
import {
  recordDismissal,
  shouldShowPrompt,
  DEFAULT_LATER_COOLDOWN_MS,
  type PromptMemory,
} from '../src/shared/prompt-memory'

const T0 = 1_700_000_000_000

describe('prompt-memory', () => {
  it('an unseen prompt is shown', () => {
    expect(shouldShowPrompt({}, 'register', T0)).toBe(true)
  })

  it('"Don\'t ask again" (never) suppresses it forever', () => {
    const mem = recordDismissal({}, 'register', 'never', T0)
    expect(shouldShowPrompt(mem, 'register', T0 + 1)).toBe(false)
    expect(shouldShowPrompt(mem, 'register', T0 + 10 * DEFAULT_LATER_COOLDOWN_MS)).toBe(false)
  })

  it('"Not now" (later) snoozes until the cooldown lapses, then shows again', () => {
    const mem = recordDismissal({}, 'register', 'later', T0)
    expect(shouldShowPrompt(mem, 'register', T0 + DEFAULT_LATER_COOLDOWN_MS - 1)).toBe(false)
    expect(shouldShowPrompt(mem, 'register', T0 + DEFAULT_LATER_COOLDOWN_MS)).toBe(true)
  })

  it('remembers each prompt id independently', () => {
    let mem: PromptMemory = {}
    mem = recordDismissal(mem, 'register', 'never', T0)
    mem = recordDismissal(mem, 'update', 'later', T0)
    expect(shouldShowPrompt(mem, 'register', T0 + 1)).toBe(false)
    expect(shouldShowPrompt(mem, 'update', T0 + DEFAULT_LATER_COOLDOWN_MS)).toBe(true)
    expect(shouldShowPrompt(mem, 'other', T0)).toBe(true)
  })

  it('a later choice can be upgraded to never', () => {
    let mem = recordDismissal({}, 'register', 'later', T0)
    mem = recordDismissal(mem, 'register', 'never', T0 + 1000)
    expect(shouldShowPrompt(mem, 'register', T0 + 10 * DEFAULT_LATER_COOLDOWN_MS)).toBe(false)
  })
})
