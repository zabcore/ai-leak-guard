// Teams Lite — the enrollment/check-in HTTP client. THE ONLY `fetch` in the
// extension's own code.
//
// This module is loaded ONLY via dynamic `import()` from enrolled code paths
// (the popup's Enroll click and the service worker's check-in scheduler, which
// runs only when enrolled). The Free, unenrolled mode never imports it, so no
// network call is even reachable before an explicit enrollment. Because it is a
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

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json()
  } catch {
    return null
  }
}
