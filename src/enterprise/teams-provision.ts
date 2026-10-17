// Teams Lite (deployment m1) — managed-deployment provisioning orchestration.
//
// The extension side of Contract B §5a. Exchanges a deployment token for a
// per-install credential via the injectable `provision` client, implementing the
// retry-safety the contract requires on the CLIENT:
//   • persist the attempt secret BEFORE the first request, and REUSE it on retry
//     (worker teardown / browser restart never spawns a second attempt — §5a #2);
//   • bind the attempt to the deployment token it is attempting against (§5a #3);
//   • on a network failure keep the attempt (so a retry recovers a lost response
//     with the same attempt_id — §5a #1/#5); on any terminal outcome clear it;
//   • on `token_revoked` / `install_revoked` never enrol (§5a #7).
// The decision of WHETHER to provision (policy present, not enrolled, not
// revoke-blocked) is `planManagedBootstrap`; this module performs an approved
// provisioning. The server owns capacity/recovery accounting; this module never
// logs the attempt secret.

import { getBackendConfig } from './teams-config'
import { deriveIdempotencyKey } from '../shared/teams-contract'
import { commitEnrollment, getEnrollment } from '../shared/teams-storage'
import {
  getProvisionAttempt,
  setProvisionAttempt,
  clearProvisionAttempt,
  type ProvisionAttempt,
} from '../shared/teams-provision-attempt'
import type { provision as provisionFn } from './teams-client'
import { attemptRef, nowHr, traceEvent } from '../shared/teams-trace'

export type ProvisionRunOutcome =
  | 'already-enrolled'
  | 'enrolled'
  | 'not-configured'
  | 'invalid-token'
  | 'exhausted'
  | 'expired'
  | 'token-revoked'
  | 'install-revoked'
  | 'recovery-expired'
  | 'network'

export interface ProvisionRunDeps {
  /** The deployment token from the managed policy. */
  readonly deploymentToken: string
  /** Injectable client loader (default: dynamic import of the egress chunk). */
  readonly loadClient?: () => Promise<{ provision: typeof provisionFn }>
  /** Injectable high-entropy id generator (default: crypto.randomUUID). */
  readonly newId?: () => string
  /** What fired this run (trace only). */
  readonly trigger?: string
}

const defaultLoadClient = (): Promise<{ provision: typeof provisionFn }> => import('./teams-client')

/** CSPRNG only: the attempt id is a proof secret, so there is no weak fallback
 *  (no Math.random / Date.now). Throws if no secure source exists. */
function defaultNewId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Run (or recover) one provisioning attempt for `deploymentToken`. No-op when
 * already enrolled. Persists the attempt before the request and reuses an
 * existing attempt for the same token so a lost response is recoverable without
 * consuming another slot.
 */
export async function runProvision(deps: ProvisionRunDeps): Promise<ProvisionRunOutcome> {
  if ((await getEnrollment()) !== null) return 'already-enrolled'

  const config = getBackendConfig()
  if (config === null) return 'not-configured'

  // Reuse a persisted attempt bound to THIS token; otherwise mint + persist one
  // BEFORE the request (survives worker teardown / restart — §5a #2).
  const newId = deps.newId ?? defaultNewId
  const existing = await getProvisionAttempt()
  let attempt: ProvisionAttempt
  const reused = existing !== null && existing.deploymentToken === deps.deploymentToken
  if (reused) {
    attempt = existing
  } else {
    const attemptId = newId()
    attempt = {
      attemptId,
      deploymentToken: deps.deploymentToken,
      idempotencyKey: await deriveIdempotencyKey('provision', attemptId),
      createdAt: new Date().toISOString(),
    }
    await setProvisionAttempt(attempt)
  }

  const { provision } = await (deps.loadClient ?? defaultLoadClient)()
  // Trace BEFORE the request, and wait for it to persist: an attempt that hangs,
  // is blocked, or dies with the worker is still on record (Track D close-out).
  const ref = await attemptRef(attempt.attemptId)
  await traceEvent('provision-start', {
    trigger: deps.trigger ?? 'unknown',
    attempt: reused ? 'reused' : 'new',
    attemptRef: ref,
  })
  const result = await provision(config.baseUrl, config.anonKey, {
    deployment_token: deps.deploymentToken,
    attempt_id: attempt.attemptId,
    // Always re-derived from the attempt id (pinned contract), so even an
    // attempt persisted by an older build sends the canonical key.
    idempotency_key: await deriveIdempotencyKey('provision', attempt.attemptId),
  })

  const receivedAt = nowHr()
  if (!result.ok && result.code === 'install_revoked') {
    await traceEvent(
      'revoke-response-received',
      { source: 'provision', attemptRef: ref },
      receivedAt,
    )
  }

  if (result.ok) {
    // The store refuses to overwrite another install's enrollment (invariant):
    // a policy-driven provision never silently switches clinics.
    const stored = await commitEnrollment({
      install_id: result.data.install_id,
      install_credential: result.data.install_credential,
      org_id: result.data.org_id,
      org_name: result.data.org_name,
      base_url: config.baseUrl,
    })
    await clearProvisionAttempt()
    const outcome = stored.ok ? 'enrolled' : 'already-enrolled'
    await traceEvent('provision-result', {
      outcome,
      attemptRef: ref,
      install_id: result.data.install_id,
      org_id: result.data.org_id,
    })
    return outcome
  }

  const outcome = provisionFailureOutcome(result.code)
  if (outcome !== 'network') await clearProvisionAttempt() // keep it for a same-attempt retry
  await traceEvent('provision-result', { outcome, attemptRef: ref })
  return outcome
}

function provisionFailureOutcome(
  code: Exclude<Awaited<ReturnType<typeof provisionFn>>, { ok: true }>['code'],
): ProvisionRunOutcome {
  switch (code) {
    case 'network':
      return 'network'
    case 'invalid_token':
      return 'invalid-token'
    case 'exhausted':
      return 'exhausted'
    case 'expired':
      return 'expired'
    case 'token_revoked':
      return 'token-revoked'
    case 'install_revoked':
      return 'install-revoked'
    case 'recovery_window_expired':
      return 'recovery-expired'
  }
}
