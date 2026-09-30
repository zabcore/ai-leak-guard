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
import type { checkin as checkinFn, enroll as enrollFn } from './teams-client'

export interface TeamsClientDeps {
  readonly loadClient?: () => Promise<{ enroll: typeof enrollFn; checkin: typeof checkinFn }>
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
  inFlightCheckin ??= runCheckinOnce(deps).finally(() => {
    inFlightCheckin = null
  })
  return inFlightCheckin
}

async function runCheckinOnce(deps: TeamsClientDeps): Promise<CheckinRunOutcome> {
  const enrollment = await getEnrollment()
  if (enrollment === null) return 'skipped-unenrolled'
  const config = getBackendConfig()
  if (config === null) return 'not_configured'

  const managed = await getManagedState()
  const request = buildCheckinRequest({
    install_id: enrollment.install_id,
    credential: enrollment.install_credential,
    extension_version: extensionVersion(),
    self_test: await realSelfTestEvidence(),
    applied_settings_revision: managed?.appliedSettingsRevision,
  })

  const { checkin } = await (deps.loadClient ?? defaultLoadClient)()
  const call = await checkin(enrollment.base_url, config.anonKey, request)

  // A concurrent unenroll (popup) or a revocation processed elsewhere may have
  // cleared the enrollment while this request was in flight. If so, DO NOT apply
  // a now-stale result over the restored user preferences.
  if ((await getEnrollment()) === null) return 'skipped-unenrolled'

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
