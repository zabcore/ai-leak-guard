// Teams Lite — `chrome.storage.local` schema for enrollment + managed state.
//
// Keys (all absent/null in the Free, unenrolled mode):
//   • teamsEnrollment      — the enrolled identity + per-install credential
//                            (credential stored ONCE from the enroll response).
//   • teamsManaged         — the applied managed overlay (revision + org).
//   • teamsPreManagedPrefs — a SNAPSHOT of the user's own local prefs taken the
//                            first time management overrode them, so a
//                            revocation restores the user's choices instead of a
//                            blind default. Stored SEPARATELY from the user's
//                            live prefs (owner instruction 3).
//
// No `fetch` and no network here — this module is safe for the free path to
// import (the type surface) without loading the enrollment client.

export interface TeamsEnrollment {
  readonly install_id: string
  readonly install_credential: string
  readonly org_id: string
  readonly org_name: string
  /** The Supabase functions base URL used for this enrollment's check-ins. */
  readonly base_url: string
}

/** The currently-applied managed overlay. Present only while management is active. */
export interface TeamsManagedState {
  readonly appliedSettingsRevision: number
  readonly orgId: string
}

/** Snapshot of the user's own prefs before management first overrode them. Only
 *  the keys management can override are recorded; a missing key means "no prior
 *  user preference recorded → fall back to the extension default on restore." */
export interface PreManagedPrefs {
  readonly showIndicator?: boolean
}

export const TEAMS_ENROLLMENT_KEY = 'teamsEnrollment'
export const TEAMS_MANAGED_KEY = 'teamsManaged'
export const TEAMS_PRE_MANAGED_KEY = 'teamsPreManagedPrefs'
/** Set true after a CONFIRMED server-side revocation (not a user unenroll), so
 *  the popup can show a "revoked by your organization" status. Cleared on the
 *  next enroll or user unenroll. */
export const TEAMS_REVOKED_KEY = 'teamsRevoked'

export async function getEnrollment(): Promise<TeamsEnrollment | null> {
  const stored = await chrome.storage.local.get(TEAMS_ENROLLMENT_KEY)
  const raw = stored[TEAMS_ENROLLMENT_KEY] as Partial<TeamsEnrollment> | undefined
  if (
    raw === undefined ||
    raw === null ||
    typeof raw.install_id !== 'string' ||
    typeof raw.install_credential !== 'string' ||
    typeof raw.org_id !== 'string' ||
    typeof raw.org_name !== 'string' ||
    typeof raw.base_url !== 'string'
  ) {
    return null
  }
  return {
    install_id: raw.install_id,
    install_credential: raw.install_credential,
    org_id: raw.org_id,
    org_name: raw.org_name,
    base_url: raw.base_url,
  }
}

/** Raw write. Producers of a NEW credential must use `commitEnrollment`. */
export async function setEnrollment(value: TeamsEnrollment): Promise<void> {
  await chrome.storage.local.set({ [TEAMS_ENROLLMENT_KEY]: value })
}

export type CommitEnrollmentResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'already_enrolled' }

let commitChain: Promise<unknown> = Promise.resolve()

/**
 * Store a FRESHLY ISSUED credential (provision, join, code-entry enroll). The
 * existing-enrollment / clinic-switch rule is enforced HERE, at the store, not
 * only by callers: if a different install is already enrolled the new
 * credential is refused and the existing enrollment is left untouched — so a
 * competing join tab, a racing code-entry enroll or a different invitation can
 * never silently overwrite it. Re-storing the SAME install (a recovered /
 * replayed credential) is allowed. Commits are serialized within the worker.
 */
export function commitEnrollment(value: TeamsEnrollment): Promise<CommitEnrollmentResult> {
  const run = commitChain.then(async (): Promise<CommitEnrollmentResult> => {
    const existing = await getEnrollment()
    if (existing !== null && existing.install_id !== value.install_id) {
      return { ok: false, reason: 'already_enrolled' }
    }
    await setEnrollment(value)
    return { ok: true }
  })
  commitChain = run.catch(() => undefined)
  return run
}

export async function clearEnrollment(): Promise<void> {
  await chrome.storage.local.remove(TEAMS_ENROLLMENT_KEY)
}

/** True when this install is enrolled (a credential is on record). */
export async function isEnrolled(): Promise<boolean> {
  return (await getEnrollment()) !== null
}

export async function getManagedState(): Promise<TeamsManagedState | null> {
  const stored = await chrome.storage.local.get(TEAMS_MANAGED_KEY)
  const raw = stored[TEAMS_MANAGED_KEY] as Partial<TeamsManagedState> | undefined
  if (
    raw === undefined ||
    raw === null ||
    typeof raw.appliedSettingsRevision !== 'number' ||
    typeof raw.orgId !== 'string'
  ) {
    return null
  }
  return { appliedSettingsRevision: raw.appliedSettingsRevision, orgId: raw.orgId }
}

export async function setManagedState(value: TeamsManagedState | null): Promise<void> {
  if (value === null) {
    await chrome.storage.local.remove(TEAMS_MANAGED_KEY)
    return
  }
  await chrome.storage.local.set({ [TEAMS_MANAGED_KEY]: value })
}

export async function getPreManagedPrefs(): Promise<PreManagedPrefs | null> {
  const stored = await chrome.storage.local.get(TEAMS_PRE_MANAGED_KEY)
  const raw = stored[TEAMS_PRE_MANAGED_KEY] as PreManagedPrefs | undefined
  if (raw === undefined || raw === null || typeof raw !== 'object') return null
  const out: { showIndicator?: boolean } = {}
  if (typeof raw.showIndicator === 'boolean') out.showIndicator = raw.showIndicator
  return out
}

export async function setPreManagedPrefs(value: PreManagedPrefs | null): Promise<void> {
  if (value === null) {
    await chrome.storage.local.remove(TEAMS_PRE_MANAGED_KEY)
    return
  }
  await chrome.storage.local.set({ [TEAMS_PRE_MANAGED_KEY]: value })
}

export async function getRevokedNotice(): Promise<boolean> {
  const stored = await chrome.storage.local.get(TEAMS_REVOKED_KEY)
  return stored[TEAMS_REVOKED_KEY] === true
}

export async function setRevokedNotice(value: boolean): Promise<void> {
  if (value) {
    await chrome.storage.local.set({ [TEAMS_REVOKED_KEY]: true })
    return
  }
  await chrome.storage.local.remove(TEAMS_REVOKED_KEY)
}

/** Set after a CONFIRMED revocation of this install (Contract B §5b). Blocks
 *  managed-policy auto-enroll so a removed browser is never silently re-enrolled.
 *  Unlike `teamsRevoked` (a UI notice), this block is NOT cleared by a new or
 *  rotated policy token, by a code enroll ("Activate"), or by a user unenroll —
 *  only by an explicit authorized recovery (`clearRevokeBlock`). */
export const TEAMS_REVOKE_BLOCK_KEY = 'teamsRevokeBlock'

export async function getRevokeBlock(): Promise<boolean> {
  const stored = await chrome.storage.local.get(TEAMS_REVOKE_BLOCK_KEY)
  return stored[TEAMS_REVOKE_BLOCK_KEY] === true
}

export async function setRevokeBlock(): Promise<void> {
  await chrome.storage.local.set({ [TEAMS_REVOKE_BLOCK_KEY]: true })
}

/** Lift the revoke block. Call ONLY from an explicit, authorized recovery
 *  action (Contract B §5a #8) — never from a policy change or an enroll. */
export async function clearRevokeBlock(): Promise<void> {
  await chrome.storage.local.remove(TEAMS_REVOKE_BLOCK_KEY)
}
