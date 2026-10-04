// Teams Lite — the PURE reconciliation state machine (requirement 2 of #78).
//
// Given the current persisted state + the outcome of one check-in attempt, it
// decides what (if anything) to change. It performs NO storage writes and does
// NO network — the service layer applies the decision. That keeps every branch
// of the offline-vs-revocation distinction unit-testable in isolation.
//
// The invariants it encodes:
//   • Offline / any non-2xx / network error → RETAIN the last valid config and
//     retry later. An error is NEVER read as a (downgraded) new config.
//   • target_settings_revision > applied → APPLY: snapshot the user's prior pref
//     on the FIRST override only, set the managed value, record the new revision.
//   • target == applied (or older) → NO-OP.
//   • Confirmed {revoked:true} → REVOKE: stop management, remove the managed
//     overlay, and RESTORE the user's previous local preference (the value from
//     before management first overrode it); fall back to the extension default
//     ONLY where no prior user preference was recorded. Never a blind reset.
//
// Local scanning + warn-and-review protection is unaffected in every branch —
// this module only ever touches the managed-indicator overlay.

import { DEFAULT_SHOW_INDICATOR } from '../shared/storage'
import type { ManagedSettings } from '../shared/teams-contract'
import type { PreManagedPrefs, TeamsManagedState } from '../shared/teams-storage'

/** The outcome of one check-in attempt, normalized for the state machine. */
export type CheckinOutcome =
  | { readonly kind: 'error' } // offline / non-2xx / network / malformed body
  | { readonly kind: 'revoked' } // confirmed {revoked:true} (credential verified server-side)
  | {
      readonly kind: 'active'
      readonly orgId: string
      readonly targetSettingsRevision: number
      readonly settings: ManagedSettings
    }

export interface ReconcileState {
  /** Current managed overlay, or null when management is not currently applied. */
  readonly managed: TeamsManagedState | null
  /** Snapshot of the user's prefs from before the first override, or null. */
  readonly preManaged: PreManagedPrefs | null
  /** The EFFECTIVE `showIndicator` currently persisted in user prefs. */
  readonly currentShowIndicator: boolean
}

/** What the service layer should persist. Absent fields are left untouched. */
export type Reconciliation =
  | { readonly action: 'retain' } // keep everything (error path or nothing to do)
  | { readonly action: 'noop' } // active, but the revision is already applied
  | {
      readonly action: 'apply'
      readonly nextManaged: TeamsManagedState
      readonly nextPreManaged: PreManagedPrefs
      readonly nextShowIndicator: boolean
    }
  | {
      readonly action: 'revoke'
      /** Present only when a prior override was in effect (else leave prefs be). */
      readonly restoreShowIndicator: boolean | null
      readonly clearManaged: true
      readonly clearPreManaged: true
    }

/**
 * Decide the next state from the current state + a single check-in outcome.
 * Pure: same inputs → same output, no side effects.
 */
export function reconcileCheckin(state: ReconcileState, outcome: CheckinOutcome): Reconciliation {
  // Offline / error: never downgrade; keep the last valid config and retry.
  if (outcome.kind === 'error') {
    return { action: 'retain' }
  }

  // Confirmed revocation: stop management, remove the overlay, restore the
  // user's own prior preference (snapshot), or the extension default where none
  // was recorded. If management was never actually applied (no snapshot), leave
  // the user's current preference untouched — there is nothing to "restore".
  if (outcome.kind === 'revoked') {
    const restore =
      state.preManaged !== null
        ? (state.preManaged.showIndicator ?? DEFAULT_SHOW_INDICATOR)
        : null
    return { action: 'revoke', restoreShowIndicator: restore, clearManaged: true, clearPreManaged: true }
  }

  // Active management. Apply only a STRICTLY newer revision.
  const applied = state.managed?.appliedSettingsRevision ?? null
  if (applied !== null && outcome.targetSettingsRevision <= applied) {
    return { action: 'noop' }
  }

  // Snapshot the user's prior pref on the FIRST override only (so a later
  // revision bump can't overwrite the original user value we must restore).
  const nextPreManaged: PreManagedPrefs =
    state.preManaged !== null ? state.preManaged : { showIndicator: state.currentShowIndicator }

  return {
    action: 'apply',
    nextManaged: {
      appliedSettingsRevision: outcome.targetSettingsRevision,
      orgId: outcome.orgId,
    },
    nextPreManaged,
    nextShowIndicator: outcome.settings.show_indicator,
  }
}
