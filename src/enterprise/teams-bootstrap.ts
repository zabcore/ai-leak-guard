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
// Serialized: startup, install, the managed-storage change event, and the retry
// alarm can all fire together. One shared in-flight run means two concurrent
// callers can't both mint a fresh attempt (which could burn two slots).

import { planManagedBootstrap, type BootstrapSkipReason } from '../background/teams-bootstrap-plan'
import { readManagedPolicy } from '../shared/teams-managed-policy'
import { getEnrollment, getRevokeBlock, setRevokeBlock } from '../shared/teams-storage'
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
}

let inFlight: Promise<ManagedBootstrapResult> | null = null

export function runManagedBootstrap(
  deps: ManagedBootstrapDeps = {},
): Promise<ManagedBootstrapResult> {
  inFlight ??= runOnce(deps).finally(() => {
    inFlight = null
  })
  return inFlight
}

async function runOnce(deps: ManagedBootstrapDeps): Promise<ManagedBootstrapResult> {
  const decision = planManagedBootstrap({
    enrolled: (await getEnrollment()) !== null,
    revokedBlock: await getRevokeBlock(),
    policy: await (deps.readPolicy ?? readManagedPolicy)(),
  })
  if (decision.action === 'skip') return decision

  const outcome = await runProvision({
    deploymentToken: decision.deploymentToken,
    ...(deps.loadClient !== undefined ? { loadClient: deps.loadClient } : {}),
    ...(deps.newId !== undefined ? { newId: deps.newId } : {}),
  })

  if (outcome === 'install-revoked') await setRevokeBlock()
  return { action: 'provision', outcome }
}
