// Teams Lite (deployment m1) — managed-policy bootstrap orchestration.
//
// Glues local state + the Chrome managed policy to the pure decision core
// (`planManagedBootstrap`) and, only when that core says `provision`, to the
// provisioning client (`runProvision`). Contract B §5 / §5b.
//
//   • No policy / no token        → skip; NO network (reading managed storage is
//                                    a local call).
//   • autoEnroll:false            → skip.
//   • Already enrolled            → skip; a changed token never moves an
//                                    enrolled browser to another clinic.
//   • Revoke block set            → skip; survives rotation and "Activate".
//   • Otherwise                   → runProvision with the policy's token.
//
// Revoke block on a confirmed revoke: the check-in path sets it when the server
// confirms revocation (`teams-service`). Here, `/provision` answers explicitly:
// `install_revoked` (this installation was removed) sets the block, which then
// survives token rotation; `token_revoked` (only the deployment token was
// revoked) does NOT, so a rotated / new token may still enroll.
//
// Serialized: startup, install, the managed-storage change event, the retry
// alarm and the install re-check can all fire together. One shared in-flight run
// means two concurrent callers can't both mint a fresh attempt (which could burn
// two slots).
//
// Coalesced, not swallowed (F-TD-1): a trigger that arrives AFTER the running
// pass has read the managed policy may carry a newer policy than that pass saw —
// e.g. a force-install whose `onInstalled` read an empty policy just before
// Chrome delivered it, and whose `storage.onChanged('managed')` then joined that
// pass. Such a trigger makes the run do ONE more pass (bounded) before it
// settles, and every joined caller gets the final result. A trigger that arrives
// before the policy read needs nothing: the pass will see the same policy.
// Every pass still goes through `runProvision`, which reuses the persisted
// attempt for the same token (Contract B §5a #2), so a rerun can never mint a
// second attempt or consume an extra slot. No rerun after a `network` outcome:
// the retry alarm owns that, with the same attempt.
//
// Every pass is recorded (content-free) for the popup / support:
// `recordBootstrapAttempt`.

import { planManagedBootstrap, type BootstrapSkipReason } from '../background/teams-bootstrap-plan'
import { readManagedPolicy } from '../shared/teams-managed-policy'
import { getEnrollment, getRevokeBlock, setRevokeBlock } from '../shared/teams-storage'
import { recordBootstrapAttempt } from '../shared/teams-diag'
import { traceEvent } from '../shared/teams-trace'
import { runProvision, type ProvisionRunDeps, type ProvisionRunOutcome } from './teams-provision'
import type { ManagedDeploymentPolicy } from '../background/teams-bootstrap-plan'

export type ManagedBootstrapResult =
  | { readonly action: 'skip'; readonly reason: BootstrapSkipReason }
  | { readonly action: 'provision'; readonly outcome: ProvisionRunOutcome }

export interface ManagedBootstrapDeps {
  /** Injectable policy reader (default: `chrome.storage.managed`). */
  readonly readPolicy?: () => Promise<ManagedDeploymentPolicy | null>
  /** Provision client loader. The service worker passes its STATIC client. */
  readonly loadClient?: ProvisionRunDeps['loadClient']
  /** Injectable id generator (tests). */
  readonly newId?: ProvisionRunDeps['newId']
  /** What fired this run (diagnostics only): install | startup | policy-change | … */
  readonly trigger?: string
}

/** Passes one run may make: the first, plus at most this many coalesced reruns. */
export const MAX_BOOTSTRAP_RERUNS = 2

let inFlight: Promise<ManagedBootstrapResult> | null = null
/** True once the running pass has started reading the managed policy. */
let policyReadStarted = false
/** Trigger of a caller that joined after the policy read (null = no rerun owed). */
let rerunTrigger: string | null = null

export function runManagedBootstrap(
  deps: ManagedBootstrapDeps = {},
): Promise<ManagedBootstrapResult> {
  if (inFlight !== null) {
    if (policyReadStarted) rerunTrigger = deps.trigger ?? 'unknown'
    return inFlight
  }
  inFlight = runCoalesced(deps).finally(() => {
    inFlight = null
    policyReadStarted = false
    rerunTrigger = null
  })
  return inFlight
}

async function runCoalesced(deps: ManagedBootstrapDeps): Promise<ManagedBootstrapResult> {
  let result = await runOnce(deps, deps.trigger ?? 'unknown')
  for (let i = 0; i < MAX_BOOTSTRAP_RERUNS && rerunTrigger !== null; i++) {
    if (!newerPolicyCouldChange(result)) break
    const trigger = rerunTrigger
    rerunTrigger = null
    result = await runOnce(deps, trigger)
  }
  return result
}

/** Whether a newer policy could change this result. Not after enrolling (the
 *  caller must see `enrolled` to run the first check-in), not for a revoke block
 *  (permanent by design), and not after `network` (the retry alarm reuses the
 *  attempt). */
function newerPolicyCouldChange(result: ManagedBootstrapResult): boolean {
  if (result.action === 'skip')
    return result.reason === 'no-policy' || result.reason === 'autoenroll-off'
  switch (result.outcome) {
    case 'invalid-token':
    case 'expired':
    case 'token-revoked':
    case 'exhausted':
    case 'recovery-expired':
      return true
    default:
      return false
  }
}

async function runOnce(
  deps: ManagedBootstrapDeps,
  trigger: string,
): Promise<ManagedBootstrapResult> {
  policyReadStarted = false
  const enrolled = (await getEnrollment()) !== null
  const revokedBlock = await getRevokeBlock()
  policyReadStarted = true
  const policy = await (deps.readPolicy ?? readManagedPolicy)()
  const decision = planManagedBootstrap({ enrolled, revokedBlock, policy })
  const tokenPresent = typeof policy?.deploymentToken === 'string' && policy.deploymentToken !== ''

  // Trace every decision on a policy-managed browser (a token is present) — a
  // Free user's `no-policy` passes stay out of the trace.
  if (tokenPresent) {
    await traceEvent('bootstrap-decision', {
      trigger,
      action: decision.action,
      reason: decision.action === 'skip' ? decision.reason : null,
      enrolled,
      revokedBlock,
    })
  }

  if (decision.action === 'skip') {
    await recordBootstrapAttempt({
      at: new Date().toISOString(),
      trigger,
      action: 'skip',
      result: decision.reason,
      tokenPresent,
    })
    return decision
  }

  const outcome = await runProvision({
    deploymentToken: decision.deploymentToken,
    ...(deps.loadClient !== undefined ? { loadClient: deps.loadClient } : {}),
    ...(deps.newId !== undefined ? { newId: deps.newId } : {}),
    trigger,
  })

  if (outcome === 'install-revoked') {
    await setRevokeBlock()
    await traceEvent('cleanup-completed', { source: 'provision', revokeBlock: true })
  }
  await recordBootstrapAttempt({
    at: new Date().toISOString(),
    trigger,
    action: 'provision',
    result: outcome,
    tokenPresent,
  })
  return { action: 'provision', outcome }
}
