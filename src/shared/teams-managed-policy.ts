// Teams Lite (deployment m1) — read the admin's Chrome managed policy.
//
// The policy arrives via `chrome.storage.managed`, shaped by
// `public/managed_schema.json` (Contract B §5). The schema is deliberately
// narrow: `{ deploymentToken: string, autoEnroll?: boolean }` and NOTHING else —
// in particular there is no free-form backend URL, so a policy can never point
// the extension at an arbitrary host; the destination stays the compiled /
// allowlisted backend from `teams-config`.
//
// Reading managed storage is a local API call — no network. Anything that is
// not exactly the expected shape is dropped, so a malformed or hostile policy
// degrades to "no policy" (network-silent) rather than to an unexpected request.

import type { ManagedDeploymentPolicy } from '../background/teams-bootstrap-plan'

/** Upper bound on an accepted token; anything longer is treated as malformed. */
const MAX_TOKEN_LENGTH = 4096

/** Project a raw managed-storage object onto the policy shape (unknown keys —
 *  e.g. a smuggled `baseUrl` — are ignored). Returns null when no usable field
 *  is present. */
export function parseManagedPolicy(raw: unknown): ManagedDeploymentPolicy | null {
  if (raw === null || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const token =
    typeof r.deploymentToken === 'string' &&
    r.deploymentToken.trim() !== '' &&
    r.deploymentToken.length <= MAX_TOKEN_LENGTH
      ? r.deploymentToken.trim()
      : undefined
  const autoEnroll = typeof r.autoEnroll === 'boolean' ? r.autoEnroll : undefined
  if (token === undefined && autoEnroll === undefined) return null
  return {
    ...(token !== undefined ? { deploymentToken: token } : {}),
    ...(autoEnroll !== undefined ? { autoEnroll } : {}),
  }
}

/** Read the managed policy, or null when none is set / the area is unavailable
 *  (e.g. an unmanaged browser, or a context without `chrome.storage.managed`). */
export async function readManagedPolicy(): Promise<ManagedDeploymentPolicy | null> {
  try {
    const area = (globalThis as { chrome?: { storage?: { managed?: chrome.storage.StorageArea } } })
      .chrome?.storage?.managed
    if (area === undefined) return null
    return parseManagedPolicy(await area.get(['deploymentToken', 'autoEnroll']))
  } catch {
    return null
  }
}
