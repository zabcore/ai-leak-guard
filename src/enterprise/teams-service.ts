// Teams Lite — orchestration: enroll, check-in, unenroll.
//
// Glues `chrome.storage` (teams-storage + prefs) and the pure state machine
// (teams-state) to the network client (teams-client). The client is loaded ONLY
// via a dynamic `import()` from here, and this module's enrolled entry points
// are the ONLY callers — so the Free path never pulls the client (nor any
// `fetch`) into its graph. The client is injectable (`deps.loadClient`) so unit
// tests exercise every branch without a real network call or dynamic import.

import { getPrefs, setPrefs, getSelfTestResult } from '../shared/storage'
import {
  buildCheckinRequest,
  type EnrollResult,
  type SelfTestEvidence,
} from '../shared/teams-contract'
import {
  getEnrollment,
  setEnrollment,
  clearEnrollment,
  getManagedState,
  setManagedState,
  getPreManagedPrefs,
  setPreManagedPrefs,
  setRevokedNotice,
} from '../shared/teams-storage'
import { getBackendConfig } from './teams-config'
import { reconcileCheckin, type CheckinOutcome, type Reconciliation } from './teams-state'
import { recordCheckinAttempt } from '../shared/teams-diag'
import type { checkin as checkinFn, enroll as enrollFn } from './teams-client'

export interface TeamsClientDeps {
  readonly loadClient?: () => Promise<{ enroll: typeof enrollFn; checkin: typeof checkinFn }>
  /** Instrumentation-only label for what fired this check-in (diagnostics). */
  readonly reason?: string
}

/** Default loader: a dynamic import, so the client is its own chunk and never in
 *  the free path's graph. */
const defaultLoadClient = (): Promise<{ enroll: typeof enrollFn; checkin: typeof checkinFn }> =>
  import('./teams-client')

/** The running extension version, for the (metadata-only) check-in body. */
function extensionVersion(): string | undefined {
  try {
    const rt = (globalThis as { chrome?: { runtime?: { getManifest?: () => { version?: string } } } })
      .chrome?.runtime
    return rt?.getManifest?.().version
  } catch {
    return undefined
  }
}

/** Self-test evidence from the STORED real self-test result — `at` is that
 *  test's ORIGINAL timestamp. Returns undefined when no real self-test has run;
 *  NEVER synthesizes a timestamp at check-in time. */
async function realSelfTestEvidence(): Promise<SelfTestEvidence | undefined> {
  try {
    const rec = await getSelfTestResult()
    if (rec === null) return undefined
    return { passed: rec.result === 'confirmed', at: rec.ts }
  } catch {
    return undefined
  }
}

/**
 * Enroll this install. Validates a backend is configured, calls `/enroll`, and
 * on success stores the credential ONCE (it is never fetched again) along with
 * the org + the base URL used, so check-ins address the same backend.
 */
export async function runEnroll(
  code: string,
  label: string,
  deps: TeamsClientDeps = {},
): Promise<EnrollResult> {
  const config = getBackendConfig()
  if (config === null) return { ok: false, code: 'not_configured' }
  const { enroll } = await (deps.loadClient ?? defaultLoadClient)()
  const result = await enroll(config.baseUrl, config.anonKey, { code, label })
  if (result.ok) {
    await setEnrollment({
      install_id: result.data.install_id,
      install_credential: result.data.install_credential,
      org_id: result.data.org_id,
      org_name: result.data.org_name,
      base_url: config.baseUrl,
    })
    // A fresh enrollment clears any prior "revoked" notice.
    await setRevokedNotice(false)
  }
  return result
}

export type CheckinRunOutcome =
  | 'skipped-unenrolled'
  | 'not_configured'
  | 'retain'
  | 'noop'
  | 'apply'
  | 'revoke'

/**
 * Run one check-in. No-op (and NO network) unless enrolled. Builds the
 * content-free body, calls `/checkin`, reconciles the result through the pure
 * state machine, and persists the decision. On revocation it also clears the
 * enrollment credential (management is over) after restoring the user's prefs.
 *
 * Serialized: the service worker fires check-ins from startup, install, the
 * alarm, and the post-enroll message, so overlapping runs are possible. A single
 * shared in-flight promise makes concurrent callers reuse the same run — without
 * it, one run could read state, a second could process a revocation and clear
 * enrollment, and the first could then write back a stale managed overlay.
 */
let inFlightCheckin: Promise<CheckinRunOutcome> | null = null

export function runCheckin(deps: TeamsClientDeps = {}): Promise<CheckinRunOutcome> {
  inFlightCheckin ??= runCheckinOnce(deps)
    .catch(async (err: unknown) => {
      // Record the failure too (req: diagnostics for BOTH success and failure),
      // content-free — a short error label only, never a body/URL/credential.
      await diag(deps.reason, 'error', { error: errorLabel(err) })
      throw err
    })
    .finally(() => {
      inFlightCheckin = null
    })
  return inFlightCheckin
}

/** A short, content-free label for a thrown error (never a body or URL). */
function errorLabel(err: unknown): string {
  if (err instanceof Error && typeof err.name === 'string' && err.name.length > 0) return err.name
  return 'error'
}

/** Record one attempt for the diagnostics buffer (instrumentation only). */
async function diag(
  reason: string | undefined,
  result: CheckinRunOutcome | 'error',
  revs: {
    reported?: number | null
    received?: number | null
    applied?: number | null
    error?: string
  } = {},
): Promise<void> {
  await recordCheckinAttempt({
    at: new Date().toISOString(),
    trigger: reason ?? 'unknown',
    result,
    reported: revs.reported ?? null,
    received: revs.received ?? null,
    applied: revs.applied ?? null,
    ...(revs.error !== undefined ? { error: revs.error } : {}),
  })
}

async function runCheckinOnce(deps: TeamsClientDeps): Promise<CheckinRunOutcome> {
  const enrollment = await getEnrollment()
  if (enrollment === null) {
    await diag(deps.reason, 'skipped-unenrolled')
    return 'skipped-unenrolled'
  }
  const config = getBackendConfig()
  if (config === null) {
    await diag(deps.reason, 'not_configured')
    return 'not_configured'
  }

  const managed = await getManagedState()
  const reported = managed?.appliedSettingsRevision ?? null
  const request = buildCheckinRequest({
    install_id: enrollment.install_id,
    credential: enrollment.install_credential,
    extension_version: extensionVersion(),
    self_test: await realSelfTestEvidence(),
    applied_settings_revision: managed?.appliedSettingsRevision,
  })

  const { checkin } = await (deps.loadClient ?? defaultLoadClient)()
  const call = await checkin(enrollment.base_url, config.anonKey, request)

  // What the server returned (for diagnostics): the target revision on an active
  // 2xx; null on a non-2xx/network failure or a revocation.
  const received = call.ok && call.response.revoked !== true ? call.response.target_settings_revision : null

  // A concurrent unenroll (popup) or a revocation processed elsewhere may have
  // cleared the enrollment while this request was in flight. If so, DO NOT apply
  // a now-stale result over the restored user preferences.
  if ((await getEnrollment()) === null) {
    await diag(deps.reason, 'skipped-unenrolled', { reported, received })
    return 'skipped-unenrolled'
  }

  const outcome: CheckinOutcome = call.ok
    ? call.response.revoked === true
      ? { kind: 'revoked' }
      : {
          kind: 'active',
          orgId: call.response.org_id,
          targetSettingsRevision: call.response.target_settings_revision,
          settings: call.response.settings,
        }
    : { kind: 'error' }

  // Re-read the managed/pre-managed/prefs state fresh (it may have changed since
  // the request was built) so the reconcile decision is against current state.
  const currentManaged = await getManagedState()
  const prefs = await getPrefs()
  const preManaged = await getPreManagedPrefs()
  const reconciliation = reconcileCheckin(
    { managed: currentManaged, preManaged, currentShowIndicator: prefs.showIndicator },
    outcome,
  )
  await applyReconciliation(reconciliation)

  // A confirmed revocation ends management entirely: drop the credential so no
  // further check-ins run (prefs were already restored by applyReconciliation),
  // and record the notice so the popup can say it was revoked by the org.
  if (reconciliation.action === 'revoke') {
    await clearEnrollment()
    await setRevokedNotice(true)
  }

  // Applied revision AFTER this attempt (for diagnostics): the new revision on an
  // apply; the unchanged current revision on noop/retain; null once revoked.
  const applied =
    reconciliation.action === 'apply'
      ? reconciliation.nextManaged.appliedSettingsRevision
      : reconciliation.action === 'revoke'
        ? null
        : (currentManaged?.appliedSettingsRevision ?? null)
  await diag(deps.reason, reconciliation.action, { reported, received, applied })

  return reconciliation.action
}

/**
 * Local unenroll: stop check-ins and restore the user's own preferences exactly
 * as a confirmed revocation would (never a blind reset), then drop the
 * enrollment. Scanning + warn-and-review are unaffected.
 */
export async function runUnenroll(): Promise<void> {
  const preManaged = await getPreManagedPrefs()
  await applyReconciliation({
    action: 'revoke',
    restoreShowIndicator: preManaged !== null ? (preManaged.showIndicator ?? true) : null,
    clearManaged: true,
    clearPreManaged: true,
  })
  await clearEnrollment()
}

/** Persist a reconciliation decision. Only ever touches the managed-indicator
 *  overlay + its snapshot — never scanning/protection state. */
async function applyReconciliation(reconciliation: Reconciliation): Promise<void> {
  switch (reconciliation.action) {
    case 'retain':
    case 'noop':
      return
    case 'apply':
      // Snapshot BEFORE overwriting the effective pref (snapshot is unchanged on
      // a later revision bump — it holds the user's ORIGINAL value).
      await setPreManagedPrefs(reconciliation.nextPreManaged)
      await setManagedState(reconciliation.nextManaged)
      await setPrefs({ showIndicator: reconciliation.nextShowIndicator })
      return
    case 'revoke':
      if (reconciliation.restoreShowIndicator !== null) {
        await setPrefs({ showIndicator: reconciliation.restoreShowIndicator })
      }
      await setManagedState(null)
      await setPreManagedPrefs(null)
      return
  }
}
