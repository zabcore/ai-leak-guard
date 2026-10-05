// Teams Lite (deployment m1) — the website ⇄ extension join handoff
// (Contract A §4c step 2–3), as a pure, injectable message handler.
//
// Transport: `chrome.runtime.onMessageExternal`, reachable only from the origins
// in the manifest's `externally_connectable.matches` (the zabcore site). The
// handler re-checks the sender's origin against the same allowlist, so a widened
// manifest alone can't open it up.
//
//   { type: 'alg-join-begin' }
//       → { ok: true, challenge, challenge_method: 'S256' }   (no network)
//   { type: 'alg-join-complete', exchange_token }
//       → { ok: true, outcome: 'enrolled' } | { ok: false, error }
//
// Responses carry ONLY the non-secret challenge and an outcome label — never the
// attempt secret, the idempotency key, or the install credential.

import type { BeginJoinResult, JoinRunOutcome } from '../enterprise/teams-join'

/** The ONLY origins allowed to drive the join handoff. Keep in sync with
 *  manifest.json `externally_connectable.matches`. */
export const JOIN_HANDOFF_ORIGINS: readonly string[] = ['https://zabcore.com']
/** Only the join pages may drive the handoff (manifest: `https://zabcore.com/join*`). */
export const JOIN_HANDOFF_PATH_PREFIX = '/join'

export const JOIN_BEGIN_TYPE = 'alg-join-begin'
export const JOIN_COMPLETE_TYPE = 'alg-join-complete'

const MAX_EXCHANGE_TOKEN_LENGTH = 4096

export type JoinHandoffResponse =
  | { readonly ok: true; readonly challenge: string; readonly challenge_method: 'S256' }
  | { readonly ok: true; readonly outcome: 'enrolled' }
  | { readonly ok: false; readonly error: string }

export interface JoinHandoffDeps {
  readonly begin: () => Promise<BeginJoinResult>
  readonly complete: (exchangeToken: string) => Promise<JoinRunOutcome>
}

export interface HandoffSender {
  readonly origin?: string
  readonly url?: string
}

/** True only for a sender page on an allowlisted origin under `/join`. The page
 *  URL is required (Chrome supplies it for externally_connectable senders); an
 *  explicit `origin`, when present, must agree with it. */
function isAllowedSender(sender: HandoffSender): boolean {
  if (typeof sender.url !== 'string') return false
  let url: URL
  try {
    url = new URL(sender.url)
  } catch {
    return false
  }
  if (typeof sender.origin === 'string' && sender.origin !== url.origin) return false
  return (
    JOIN_HANDOFF_ORIGINS.includes(url.origin) && url.pathname.startsWith(JOIN_HANDOFF_PATH_PREFIX)
  )
}

/** True when `message` is a join-handoff message (the listener should answer). */
export function isJoinHandoffMessage(message: unknown): boolean {
  const type = (message as { type?: unknown } | null)?.type
  return type === JOIN_BEGIN_TYPE || type === JOIN_COMPLETE_TYPE
}

/**
 * Handle one handoff message. Returns null for messages that aren't ours.
 * Never throws: failures become `{ ok: false, error }` labels.
 */
export async function handleJoinHandoff(
  message: unknown,
  sender: HandoffSender,
  deps: JoinHandoffDeps,
): Promise<JoinHandoffResponse | null> {
  if (!isJoinHandoffMessage(message)) return null
  if (!isAllowedSender(sender)) return { ok: false, error: 'forbidden' }

  try {
    const msg = message as { type: string; exchange_token?: unknown }
    if (msg.type === JOIN_BEGIN_TYPE) {
      const begun = await deps.begin()
      return begun.ok
        ? { ok: true, challenge: begun.challenge, challenge_method: 'S256' }
        : { ok: false, error: begun.error }
    }
    const token = msg.exchange_token
    if (typeof token !== 'string' || token === '' || token.length > MAX_EXCHANGE_TOKEN_LENGTH) {
      return { ok: false, error: 'bad_request' }
    }
    const outcome = await deps.complete(token)
    return outcome === 'enrolled' ? { ok: true, outcome } : { ok: false, error: outcome }
  } catch {
    return { ok: false, error: 'internal' }
  }
}
