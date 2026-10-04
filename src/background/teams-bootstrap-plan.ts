// Teams Lite (deployment m1) — pure decision core for managed-policy bootstrap.
//
// This is the backend-independent heart of the Phase-3 "silent auto-enroll from
// an admin Chrome policy" path. It decides, from local state + the managed
// policy, whether a browser should provision (exchange the deployment token for
// a per-install credential) or skip — and it encodes the hardened safeguards so
// they are unit-testable without a live backend or a real policy:
//
//   • Already enrolled            → skip (a changed policy token must NEVER
//                                     silently transfer an enrolled browser to
//                                     another clinic — "enrolled wins").
//   • Revoke block set            → skip, and this SURVIVES token rotation and a
//                                     user clicking "Activate"; it clears ONLY via
//                                     an explicit authorized recovery action
//                                     (represented here by the caller clearing the
//                                     block — never by a new/rotated token).
//   • No deployment token in policy → skip (network-silent: no policy ⇒ nothing).
//   • autoEnroll === false        → skip (admin opt-out / staging).
//   • otherwise                   → provision with the policy's deployment token.
//
// The order makes the safety rules impossible to bypass: `enrolled` and
// `revokedBlock` are evaluated before the token, so neither a rotated token nor a
// re-pointed policy can move or revive an install. The orchestrator (service
// worker) supplies `enrolled`/`revokedBlock` from storage and the policy from
// `chrome.storage.managed`, then acts on the decision; the actual
// token→credential exchange (and its idempotent lost-response recovery) lives in
// the injectable provision client, not here.

/** The managed policy shape read from `chrome.storage.managed` (constrained:
 *  no free-form backend URL — destination is compiled-fixed/allowlisted). */
export interface ManagedDeploymentPolicy {
  readonly deploymentToken?: string
  /** Default is "auto-enroll when a token is present"; false opts out. */
  readonly autoEnroll?: boolean
}

export type BootstrapSkipReason =
  | 'already-enrolled'
  | 'revoked-block'
  | 'no-policy'
  | 'autoenroll-off'

export type BootstrapDecision =
  | { readonly action: 'provision'; readonly deploymentToken: string }
  | { readonly action: 'skip'; readonly reason: BootstrapSkipReason }

export interface BootstrapInput {
  /** True when a per-install enrollment credential is already stored. */
  readonly enrolled: boolean
  /** True when a confirmed revoke has blocked this install from auto-enrolling. */
  readonly revokedBlock: boolean
  /** The managed policy, or null when none is present. */
  readonly policy: ManagedDeploymentPolicy | null
}

/**
 * Decide whether to auto-provision from a managed deployment policy. Pure and
 * total — every branch returns a decision; the safety-critical `enrolled` and
 * `revokedBlock` checks come BEFORE the token so a rotated/re-pointed policy can
 * never silently transfer or revive an installation.
 */
export function planManagedBootstrap(input: BootstrapInput): BootstrapDecision {
  // Enrolled wins: never re-provision, and a changed policy token never moves an
  // already-enrolled browser to a different clinic.
  if (input.enrolled) return { action: 'skip', reason: 'already-enrolled' }

  // Revoke block wins over any policy and survives token rotation / Activate.
  // Only an authorized recovery (the caller clearing the block) lifts it.
  if (input.revokedBlock) return { action: 'skip', reason: 'revoked-block' }

  const token = input.policy?.deploymentToken
  if (token === undefined || token === '') return { action: 'skip', reason: 'no-policy' }

  // Admin opt-out: policy present but auto-enroll explicitly disabled.
  if (input.policy?.autoEnroll === false) return { action: 'skip', reason: 'autoenroll-off' }

  return { action: 'provision', deploymentToken: token }
}
