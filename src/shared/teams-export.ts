// Teams Lite (Track D close-out, 1.3.8) — the secret-free, read-only export.
//
// One JSON snapshot of the enrollment state for acceptance evidence, read from
// the service-worker console with the popup CLOSED (opening the popup runs a
// check-in, which would change the very state being inspected):
//
//   await algTeamsExport()
//
// Read-only and enrollment-safe: it only READS chrome.storage (local + managed)
// and the manifest. No network, no check-in, no write. Allow-listed: the export
// is built field by field — storage is never spread into it — so the install
// credential, the deployment token, the attempt secret and its idempotency key
// can never appear. `buildTeamsExport` is pure, so this is unit-tested.

import { TEAMS_BOOTSTRAP_DIAG_KEY, TEAMS_DIAG_KEY, TEAMS_NEXT_ATTEMPT_KEY } from './teams-diag'
import {
  TEAMS_ENROLLMENT_KEY,
  TEAMS_MANAGED_KEY,
  TEAMS_PRE_MANAGED_KEY,
  TEAMS_REVOKED_KEY,
  TEAMS_REVOKE_BLOCK_KEY,
} from './teams-storage'
import { TEAMS_PROVISION_ATTEMPT_KEY } from './teams-provision-attempt'
import { TEAMS_TRACE_KEY, attemptRef, parseTraceStore, traceIntegrity } from './teams-trace'

export const TEAMS_EXPORT_FORMAT = 'alg-teams-export/1'

/** Storage keys the export reads (and nothing else). */
export const TEAMS_EXPORT_KEYS = [
  TEAMS_ENROLLMENT_KEY,
  TEAMS_MANAGED_KEY,
  TEAMS_PRE_MANAGED_KEY,
  TEAMS_REVOKED_KEY,
  TEAMS_REVOKE_BLOCK_KEY,
  TEAMS_PROVISION_ATTEMPT_KEY,
  'teamsProvisionRetryCount',
  'teamsBootstrapRecheckCount',
  TEAMS_BOOTSTRAP_DIAG_KEY,
  TEAMS_DIAG_KEY,
  TEAMS_NEXT_ATTEMPT_KEY,
  TEAMS_TRACE_KEY,
  'prefs',
] as const

export interface TeamsExportInput {
  readonly exportedAt: string
  readonly extensionId: string | null
  readonly version: string | null
  /** chrome.storage.local values for TEAMS_EXPORT_KEYS (missing = absent). */
  readonly local: Readonly<Record<string, unknown>>
  /** chrome.storage.managed (the admin policy), or null when unavailable. */
  readonly managedPolicy: Readonly<Record<string, unknown>> | null
  /** Non-secret reference of the pending provisioning attempt, if any. */
  readonly pendingAttemptRef: string | null
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null)
const obj = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

/** Pick only allow-listed primitive fields from a diagnostics entry. */
function pick(entry: unknown, keys: readonly string[]): Record<string, unknown> {
  const o = obj(entry) ?? {}
  const out: Record<string, unknown> = {}
  for (const k of keys) {
    const v = o[k]
    if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) out[k] = v
  }
  return out
}

/** Build the export from raw reads. Pure. Every field is chosen explicitly. */
export function buildTeamsExport(input: TeamsExportInput) {
  const { local } = input
  const enrollment = obj(local[TEAMS_ENROLLMENT_KEY])
  const managed = obj(local[TEAMS_MANAGED_KEY])
  const preManaged = obj(local[TEAMS_PRE_MANAGED_KEY])
  const prefs = obj(local.prefs)
  const policy = input.managedPolicy
  const token = policy?.deploymentToken
  const trace = parseTraceStore(local[TEAMS_TRACE_KEY])

  return {
    format: TEAMS_EXPORT_FORMAT,
    exportedAt: input.exportedAt,
    extension: { id: input.extensionId, version: input.version },
    identity: {
      enrolled: enrollment !== null,
      install_id: str(enrollment?.install_id),
      org_id: str(enrollment?.org_id),
      org_name: str(enrollment?.org_name),
    },
    revoke: {
      revokeBlock: local[TEAMS_REVOKE_BLOCK_KEY] === true,
      revokedNotice: local[TEAMS_REVOKED_KEY] === true,
    },
    managedState: {
      present: managed !== null,
      appliedSettingsRevision: num(managed?.appliedSettingsRevision),
      orgId: str(managed?.orgId),
    },
    showIndicator: {
      /** What the extension shows now (absent pref = the default, true). */
      current: bool(prefs?.showIndicator) ?? true,
      currentIsDefault: bool(prefs?.showIndicator) === null,
      /** The user's own value saved before management overrode it (null = none saved). */
      saved: bool(preManaged?.showIndicator),
      savedRecordPresent: preManaged !== null,
    },
    policy: {
      present: policy !== null && Object.keys(policy).length > 0,
      tokenPresent: typeof token === 'string' && token.trim() !== '',
      autoEnroll: bool(policy?.autoEnroll),
    },
    provisioning: {
      attemptPending: obj(local[TEAMS_PROVISION_ATTEMPT_KEY]) !== null,
      attemptRef: input.pendingAttemptRef,
      provisionRetryCount: num(local.teamsProvisionRetryCount),
      installRecheckCount: num(local.teamsBootstrapRecheckCount),
    },
    trace: {
      integrity: traceIntegrity(trace),
      events: trace?.events ?? [],
    },
    bootstrapDiag: list(local[TEAMS_BOOTSTRAP_DIAG_KEY]).map((e) =>
      pick(e, ['at', 'trigger', 'action', 'result', 'tokenPresent']),
    ),
    checkinDiag: {
      nextAttemptAt: str(local[TEAMS_NEXT_ATTEMPT_KEY]),
      recent: list(local[TEAMS_DIAG_KEY])
        .slice(-10)
        .map((e) =>
          pick(e, ['at', 'trigger', 'result', 'reported', 'received', 'applied', 'error']),
        ),
    },
  }
}

export type TeamsExport = ReturnType<typeof buildTeamsExport>

/** Read everything the export needs — reads only — and build it. */
export async function readTeamsExport(): Promise<TeamsExport> {
  const local = await chrome.storage.local.get([...TEAMS_EXPORT_KEYS])
  let managedPolicy: Record<string, unknown> | null = null
  try {
    const area = (globalThis as { chrome?: { storage?: { managed?: chrome.storage.StorageArea } } })
      .chrome?.storage?.managed
    if (area !== undefined) {
      const raw: unknown = await area.get(['deploymentToken', 'autoEnroll'])
      managedPolicy = obj(raw)
    }
  } catch {
    managedPolicy = null
  }
  const attempt = obj(local[TEAMS_PROVISION_ATTEMPT_KEY])
  const attemptId = str(attempt?.attemptId)
  let manifest: { version?: string } | undefined
  try {
    manifest = chrome.runtime.getManifest?.()
  } catch {
    manifest = undefined
  }
  return buildTeamsExport({
    exportedAt: new Date().toISOString(),
    extensionId: str(chrome.runtime?.id),
    version: str(manifest?.version),
    local,
    managedPolicy,
    pendingAttemptRef: attemptId !== null ? await attemptRef(attemptId) : null,
  })
}
