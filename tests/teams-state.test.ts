// Teams Lite (#78) — the pure reconciliation state machine (requirement 2).

import { describe, expect, it } from 'vitest'
import { reconcileCheckin, type ReconcileState } from '../src/enterprise/teams-state'

const base = (over: Partial<ReconcileState> = {}): ReconcileState => ({
  managed: null,
  preManaged: null,
  currentShowIndicator: true,
  ...over,
})

describe('reconcileCheckin — offline / error', () => {
  it('RETAINS on error (never downgrades the config)', () => {
    const r = reconcileCheckin(
      base({ managed: { appliedSettingsRevision: 5, orgId: 'o' } }),
      { kind: 'error' },
    )
    expect(r).toEqual({ action: 'retain' })
  })
})

describe('reconcileCheckin — apply (target > applied)', () => {
  it('first override snapshots the user pref, applies, records the revision', () => {
    const r = reconcileCheckin(base({ currentShowIndicator: true }), {
      kind: 'active',
      orgId: 'org_1',
      targetSettingsRevision: 1,
      settings: { show_indicator: false },
    })
    expect(r).toEqual({
      action: 'apply',
      nextManaged: { appliedSettingsRevision: 1, orgId: 'org_1' },
      nextPreManaged: { showIndicator: true }, // snapshot of the user's prior value
      nextShowIndicator: false, // the managed value
    })
  })

  it('a later revision bump does NOT re-snapshot (keeps the ORIGINAL user value)', () => {
    const r = reconcileCheckin(
      base({
        managed: { appliedSettingsRevision: 1, orgId: 'org_1' },
        preManaged: { showIndicator: true }, // original user value from the first override
        currentShowIndicator: false, // the currently-applied managed value
      }),
      {
        kind: 'active',
        orgId: 'org_1',
        targetSettingsRevision: 2,
        settings: { show_indicator: true },
      },
    )
    expect(r.action).toBe('apply')
    if (r.action === 'apply') {
      expect(r.nextPreManaged).toEqual({ showIndicator: true }) // unchanged snapshot
      expect(r.nextManaged.appliedSettingsRevision).toBe(2)
      expect(r.nextShowIndicator).toBe(true)
    }
  })
})

describe('reconcileCheckin — no-op (target <= applied)', () => {
  it('target == applied is a no-op', () => {
    const r = reconcileCheckin(
      base({ managed: { appliedSettingsRevision: 3, orgId: 'o' } }),
      { kind: 'active', orgId: 'o', targetSettingsRevision: 3, settings: { show_indicator: false } },
    )
    expect(r).toEqual({ action: 'noop' })
  })
  it('an older target is a no-op (monotonic revisions)', () => {
    const r = reconcileCheckin(
      base({ managed: { appliedSettingsRevision: 5, orgId: 'o' } }),
      { kind: 'active', orgId: 'o', targetSettingsRevision: 2, settings: { show_indicator: true } },
    )
    expect(r).toEqual({ action: 'noop' })
  })
})

describe('reconcileCheckin — revocation', () => {
  it('restores the user PRIOR preference (not a blind default) and clears overlay', () => {
    const r = reconcileCheckin(
      base({
        managed: { appliedSettingsRevision: 2, orgId: 'o' },
        preManaged: { showIndicator: true }, // user originally had it ON
        currentShowIndicator: false, // management had turned it OFF
      }),
      { kind: 'revoked' },
    )
    expect(r).toEqual({
      action: 'revoke',
      restoreShowIndicator: true, // the user's own prior value
      clearManaged: true,
      clearPreManaged: true,
    })
  })

  it('falls back to the extension default ONLY when no prior user pref was recorded', () => {
    const r = reconcileCheckin(
      base({
        managed: { appliedSettingsRevision: 2, orgId: 'o' },
        preManaged: {}, // snapshot exists but recorded no showIndicator value
        currentShowIndicator: false,
      }),
      { kind: 'revoked' },
    )
    expect(r.action).toBe('revoke')
    if (r.action === 'revoke') expect(r.restoreShowIndicator).toBe(true) // DEFAULT_SHOW_INDICATOR
  })

  it('if management was never applied (no snapshot), leaves the user pref untouched', () => {
    const r = reconcileCheckin(base({ managed: null, preManaged: null }), { kind: 'revoked' })
    expect(r).toEqual({
      action: 'revoke',
      restoreShowIndicator: null, // nothing to restore — do not overwrite the user's choice
      clearManaged: true,
      clearPreManaged: true,
    })
  })
})
