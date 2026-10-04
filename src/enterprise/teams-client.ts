// Teams Lite — the enrollment/check-in HTTP client. THE ONLY `fetch` in the
// extension's own code.
//
// Every call here is gated at RUNTIME by its caller: enroll (the popup's code
// entry) and join (the zabcore join-page handoff) only on an explicit user
// enrollment; provision only when an admin's managed policy authorizes it
// (`planManagedBootstrap`); checkin only when enrolled. The popup loads this
// module lazily; the service worker imports it statically (no dynamic import()
// in a worker) but an unenrolled worker with no policy never calls it. Because it is a
// dynamic import, Vite emits it as its own chunk, which `verify-no-network.mjs`
// allowlists BY NAME (egress gated behind explicit enrollment) — the free-mode
// silence guarantee is carried by the behavioral test, not the static scan.
//
// Auth: the Supabase anon (public) key is sent as BOTH `apikey` and
// `Authorization: Bearer` — the functions run with `verify_jwt=false` and
// authenticate the install from the body's credential. The service-role key is
// never present in the extension.

import {
  enrollErrorForStatus,
  isCheckinResponse,
  isEnrollSuccess,
  type CheckinRequest,
  type CheckinResponse,
  type EnrollRequest,
  type EnrollResult,
} from '../shared/teams-contract'

function authHeaders(anonKey: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    apikey: anonKey,
    Authorization: `Bearer ${anonKey}`,
  }
}

// Abort a request that the backend accepts but never answers — otherwise
// `runCheckin` would stay pending (and the MV3 worker could be torn down
// mid-call) and the popup's Enroll button would stick on "Enrolling…". The
// abort surfaces as a thrown fetch, which both paths already map to the RETAIN /
// `network` outcome. `AbortSignal.timeout` is a no-op-safe guard here.
const REQUEST_TIMEOUT_MS = 15_000
function requestSignal(): AbortSignal | undefined {
  try {
    return AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  } catch {
    return undefined
  }
}

/** POST /functions/v1/enroll. Maps the contract's status codes to error codes;
 *  any offline / malformed / unexpected result becomes `network` (never a
 *  spurious "invalid code"). */
export async function enroll(
  baseUrl: string,
  anonKey: string,
  req: EnrollRequest,
): Promise<EnrollResult> {
  let res: Response
  try {
    res = await fetch(`${baseUrl}/functions/v1/enroll`, {
      method: 'POST',
      headers: authHeaders(anonKey),
      body: JSON.stringify({ code: req.code, label: req.label }),
      signal: requestSignal(),
    })
  } catch {
    return { ok: false, code: 'network' }
  }

  if (res.ok) {
    const body = await readJson(res)
    if (isEnrollSuccess(body)) return { ok: true, data: body }
    return { ok: false, code: 'network' }
  }

  // 410 covers both `expired` and `revoked`; disambiguate from the body when it
  // says so, else treat as `expired`.
  if (res.status === 410) {
    const body = await readJson(res)
    const err = (body as { error?: unknown } | null)?.error
    return { ok: false, code: err === 'revoked' ? 'revoked' : 'expired' }
  }
  return { ok: false, code: enrollErrorForStatus(res.status) }
}

/** The result of a single check-in POST, normalized for the state machine. A
 *  non-2xx or network/malformed result is `{ ok: false }` → RETAIN. */
export type CheckinCallResult = { ok: true; response: CheckinResponse } | { ok: false }

/** POST /functions/v1/checkin (content-free body). */
export async function checkin(
  baseUrl: string,
  anonKey: string,
  req: CheckinRequest,
): Promise<CheckinCallResult> {
  let res: Response
  try {
    res = await fetch(`${baseUrl}/functions/v1/checkin`, {
      method: 'POST',
      headers: authHeaders(anonKey),
      body: JSON.stringify(req),
      signal: requestSignal(),
    })
  } catch {
    return { ok: false }
  }
  if (!res.ok) return { ok: false }
  const body = await readJson(res)
  if (isCheckinResponse(body)) return { ok: true, response: body }
  return { ok: false }
}

// ─── Deployment-token provisioning (managed deployment, Contract B) ──
export interface ProvisionRequest {
  readonly deployment_token: string
  readonly attempt_id: string
  readonly idempotency_key: string
}
export interface ProvisionSuccess {
  readonly install_id: string
  readonly install_credential: string
  readonly org_id: string
  readonly org_name: string
}
export type ProvisionErrorCode =
  | 'invalid_token'
  | 'exhausted'
  | 'expired'
  | 'revoked'
  | 'recovery_window_expired'
  | 'network'
export type ProvisionCallResult =
  | { ok: true; data: ProvisionSuccess }
  | { ok: false; code: ProvisionErrorCode }

function isProvisionSuccess(body: unknown): body is ProvisionSuccess {
  if (body === null || typeof body !== 'object') return false
  const b = body as Record<string, unknown>
  return (
    typeof b.install_id === 'string' &&
    typeof b.install_credential === 'string' &&
    typeof b.org_id === 'string' &&
    typeof b.org_name === 'string'
  )
}

/** POST /functions/v1/provision — exchange a deployment token for a per-install
 *  credential. Content-free body; the attempt secret travels only here (never a
 *  URL / diagnostic). Maps the contract's status codes to error codes; any
 *  offline / malformed / unexpected result becomes `network`, on which the caller
 *  retries with the SAME persisted attempt. */
export async function provision(
  baseUrl: string,
  anonKey: string,
  req: ProvisionRequest,
): Promise<ProvisionCallResult> {
  let res: Response
  try {
    res = await fetch(`${baseUrl}/functions/v1/provision`, {
      method: 'POST',
      headers: authHeaders(anonKey),
      body: JSON.stringify(req),
      signal: requestSignal(),
    })
  } catch {
    return { ok: false, code: 'network' }
  }

  if (res.ok) {
    const body = await readJson(res)
    if (isProvisionSuccess(body)) return { ok: true, data: body }
    return { ok: false, code: 'network' }
  }
  if (res.status === 404) return { ok: false, code: 'invalid_token' }
  if (res.status === 409) return { ok: false, code: 'exhausted' }
  if (res.status === 410) {
    const body = await readJson(res)
    const err = (body as { error?: unknown } | null)?.error
    if (err === 'revoked') return { ok: false, code: 'revoked' }
    if (err === 'recovery_window_expired') return { ok: false, code: 'recovery_window_expired' }
    return { ok: false, code: 'expired' }
  }
  return { ok: false, code: 'network' }
}

// ─── Staff-invitation join (connect handoff, Contract A §4c) ─────────
export interface JoinRequest {
  /** Bound by the backend to {challenge, recipient, invitation, organization}. */
  readonly exchange_token: string
  /** The extension-held code-verifier; SHA256(attempt_secret) == challenge. */
  readonly attempt_secret: string
  readonly idempotency_key: string
}
export interface JoinSuccess {
  readonly install_id: string
  readonly install_credential: string
  readonly org_id: string
  readonly org_name: string
  readonly role: 'staff'
}
export type JoinErrorCode =
  | 'invalid_proof'
  | 'expired'
  | 'revoked'
  | 'recovery_window_expired'
  | 'network'
export type JoinCallResult = { ok: true; data: JoinSuccess } | { ok: false; code: JoinErrorCode }

function isJoinSuccess(body: unknown): body is JoinSuccess {
  if (body === null || typeof body !== 'object') return false
  const b = body as Record<string, unknown>
  return (
    typeof b.install_id === 'string' &&
    typeof b.install_credential === 'string' &&
    typeof b.org_id === 'string' &&
    typeof b.org_name === 'string' &&
    b.role === 'staff'
  )
}

/** POST /functions/v1/join — redeem a bound exchange token with the attempt
 *  secret. The secret travels ONLY in this body to the backend (never to the
 *  website, a URL, or diagnostics). Offline / malformed / unexpected → `network`,
 *  on which the caller retries with the SAME persisted attempt. */
export async function join(
  baseUrl: string,
  anonKey: string,
  req: JoinRequest,
): Promise<JoinCallResult> {
  let res: Response
  try {
    res = await fetch(`${baseUrl}/functions/v1/join`, {
      method: 'POST',
      headers: authHeaders(anonKey),
      body: JSON.stringify({
        exchange_token: req.exchange_token,
        attempt_secret: req.attempt_secret,
        idempotency_key: req.idempotency_key,
      }),
      signal: requestSignal(),
    })
  } catch {
    return { ok: false, code: 'network' }
  }

  if (res.ok) {
    const body = await readJson(res)
    if (isJoinSuccess(body)) return { ok: true, data: body }
    return { ok: false, code: 'network' }
  }
  if (res.status === 401) return { ok: false, code: 'invalid_proof' }
  if (res.status === 410) {
    const body = await readJson(res)
    const err = (body as { error?: unknown } | null)?.error
    if (err === 'revoked') return { ok: false, code: 'revoked' }
    if (err === 'recovery_window_expired') return { ok: false, code: 'recovery_window_expired' }
    return { ok: false, code: 'expired' }
  }
  return { ok: false, code: 'network' }
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json()
  } catch {
    return null
  }
}
