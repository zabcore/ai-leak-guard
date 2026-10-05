// Teams Lite (deployment m1) — the persisted provisioning-attempt record.
//
// Contract B §5a #1–#3: a provisioning attempt carries a high-entropy secret
// (`attemptId`) that is PERSISTED LOCALLY BEFORE the first `/provision` request,
// so a torn-down service worker or a browser restart REUSES the same attempt
// rather than generating a new one (which would risk consuming a second
// enrollment slot / orphaning an install). The attempt is BOUND to the
// deployment token it is attempting against. The secret lives only in
// `chrome.storage.local` and is sent only in the POST body — never in a URL and
// never in diagnostics.

export const TEAMS_PROVISION_ATTEMPT_KEY = 'teamsProvisionAttempt'

export interface ProvisionAttempt {
  /** High-entropy per-attempt secret; server stores only its hash (proof). */
  readonly attemptId: string
  /** The deployment token this attempt is bound to (reuse only for the same token). */
  readonly deploymentToken: string
  /** base64url(SHA-256("alg-provision-idem:" + attemptId)) — `deriveIdempotencyKey`. */
  readonly idempotencyKey: string
  /** ISO timestamp the attempt was first persisted. */
  readonly createdAt: string
}

export async function getProvisionAttempt(): Promise<ProvisionAttempt | null> {
  try {
    const stored = await chrome.storage.local.get(TEAMS_PROVISION_ATTEMPT_KEY)
    const raw = stored[TEAMS_PROVISION_ATTEMPT_KEY] as Partial<ProvisionAttempt> | undefined
    if (
      raw === undefined ||
      raw === null ||
      typeof raw.attemptId !== 'string' ||
      typeof raw.deploymentToken !== 'string' ||
      typeof raw.idempotencyKey !== 'string' ||
      typeof raw.createdAt !== 'string'
    ) {
      return null
    }
    return {
      attemptId: raw.attemptId,
      deploymentToken: raw.deploymentToken,
      idempotencyKey: raw.idempotencyKey,
      createdAt: raw.createdAt,
    }
  } catch {
    return null
  }
}

export async function setProvisionAttempt(value: ProvisionAttempt): Promise<void> {
  await chrome.storage.local.set({ [TEAMS_PROVISION_ATTEMPT_KEY]: value })
}

export async function clearProvisionAttempt(): Promise<void> {
  await chrome.storage.local.remove(TEAMS_PROVISION_ATTEMPT_KEY)
}
