// Teams Lite (deployment m1) — the website ⇄ extension join handoff over the
// bridge/1.1.0 long-lived port (§1 transport, §2 envelope, §3 message types).
//
// Transport: the zabcore join page opens ONE port per tab with
// `chrome.runtime.connect(EXT_ID, { name: 'zc.join.v1' })`; the worker accepts it
// via `chrome.runtime.onConnectExternal`. ALL messages, both directions, flow
// over this port — there is no `sendMessage` / `onMessageExternal` path. The
// sender origin is checked against the production allowlist on connect AND on
// every inbound message; anything else gets `error {code: "bad_origin"}` and is
// closed.
//
// Envelope (every message, both directions, including the ack):
//   { ns: "zc.join", v: 1, type, nonce (UUIDv7), ts (ISO-8601 UTC), payload }
// Inbound: a nonce seen on this port in the last 60 s is ignored; a message
// older than 5 min is dropped; an unsupported `v` gets `unsupported_version`
// and the port is closed; an unknown `ns`/`type` (including the retired flat
// `{type: "alg-join-complete"}`) is ignored with `invalid_message`.
//
// Message types:
//   W→E hello          { invitation_ref, locale }
//     E→W presence     { ext_version, state }
//     E→W challenge    { attempt_challenge, expires_at }     (separate message)
//   W→E exchange_token { exchange_token, expires_at, challenge_nonce }
//     E→W ack          { nonce_of }                          (before /join)
//     E→W result       { status: "success", connected_invitation_ref,
//                        connected_attempt_challenge, connected_org_id,
//                        connected_org_name, connected_at }
//                    | { status: "failed", error_code }
//   E→W error          { code }
// `challenge_nonce` must echo the envelope nonce of a `challenge` this extension
// emitted — the REQUIRED correlation binding the token to our attempt.
//
// Nothing posted on the port ever carries the attempt secret, the idempotency
// key or the install credential.

import type { ExchangeOutcome, HelloOutcome, JoinPresenceState } from '../enterprise/teams-join'
import type { JoinResultPayload } from '../shared/teams-join-attempt'

export const JOIN_PORT_NAME = 'zc.join.v1'
export const BRIDGE_NS = 'zc.join'
export const BRIDGE_VERSION = 1
/** The ONLY origins allowed to drive the join handoff. Keep in sync with
 *  manifest.json `externally_connectable.matches`. */
export const JOIN_PORT_ORIGINS: readonly string[] = ['https://zabcore.com']
/** Only the join pages may drive the handoff (manifest: `https://zabcore.com/join*`). */
export const JOIN_PORT_PATH_PREFIX = '/join'
export const NONCE_DEDUP_MS = 60_000
export const MAX_MESSAGE_AGE_MS = 5 * 60_000

const MAX_EXCHANGE_TOKEN_LENGTH = 4096
const MAX_FIELD_LENGTH = 512
const NONCE_RE = /^[0-9A-Za-z-]{16,64}$/

export type BridgeErrorCode = 'bad_origin' | 'unsupported_version' | 'invalid_message'

export interface BridgeEnvelope {
  readonly ns: typeof BRIDGE_NS
  readonly v: typeof BRIDGE_VERSION
  readonly type: string
  readonly nonce: string
  readonly ts: string
  readonly payload: Record<string, unknown>
}

export interface PortSender {
  readonly origin?: string
  readonly url?: string
  readonly tab?: { readonly id?: number }
}

/** The subset of `chrome.runtime.Port` the server uses (injectable in tests). */
export interface JoinPort {
  readonly name: string
  readonly sender?: PortSender
  postMessage(message: unknown): void
  disconnect(): void
  readonly onMessage: { addListener(fn: (message: unknown) => void): void }
  readonly onDisconnect: { addListener(fn: () => void): void }
}

export interface JoinPortDeps {
  readonly presence: () => Promise<{ ext_version: string; state: JoinPresenceState }>
  /** Persist `challengeNonce` on the attempt, then return what to emit. */
  readonly hello: (invitationRef: string, challengeNonce: string) => Promise<HelloOutcome>
  readonly exchange: (exchangeToken: string, challengeNonce: string) => Promise<ExchangeOutcome>
  readonly now?: () => number
  readonly newNonce?: () => string
}

/** UUIDv7 (RFC 9562): 48-bit ms timestamp + random, as the per-message nonce. */
export function uuidv7(now: number = Date.now()): string {
  const b = crypto.getRandomValues(new Uint8Array(16))
  for (let i = 0; i < 6; i++) b[i] = Math.floor(now / 2 ** (8 * (5 - i))) % 256
  b[6] = ((b[6] as number) & 0x0f) | 0x70
  b[8] = ((b[8] as number) & 0x3f) | 0x80
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

/** True only for a sender page on an allowlisted origin under `/join`. The page
 *  URL is required (Chrome supplies it for externally_connectable senders); an
 *  explicit `origin`, when present, must agree with it. */
export function isAllowedSender(sender: PortSender | undefined): boolean {
  if (sender === undefined || typeof sender.url !== 'string') return false
  let url: URL
  try {
    url = new URL(sender.url)
  } catch {
    return false
  }
  if (typeof sender.origin === 'string' && sender.origin !== url.origin) return false
  return JOIN_PORT_ORIGINS.includes(url.origin) && url.pathname.startsWith(JOIN_PORT_PATH_PREFIX)
}

const isStr = (x: unknown, max = MAX_FIELD_LENGTH): x is string =>
  typeof x === 'string' && x !== '' && x.length <= max

/**
 * The port server. `onConnect` is the `chrome.runtime.onConnectExternal`
 * listener; it keeps one port per tab (a new port from the same tab replaces
 * the old one).
 */
export function createJoinPortServer(deps: JoinPortDeps): { onConnect(port: JoinPort): void } {
  const now = deps.now ?? Date.now
  const newNonce = deps.newNonce ?? (() => uuidv7(now()))
  const portsByTab = new Map<number, JoinPort>()

  function envelope(
    type: string,
    payload: Record<string, unknown>,
    nonce = newNonce(),
  ): BridgeEnvelope {
    return {
      ns: BRIDGE_NS,
      v: BRIDGE_VERSION,
      type,
      nonce,
      ts: new Date(now()).toISOString(),
      payload,
    }
  }

  function onConnect(port: JoinPort): void {
    if (port.name !== JOIN_PORT_NAME) return // not ours
    let open = true
    const post = (env: BridgeEnvelope): void => {
      if (!open) return
      try {
        port.postMessage(env)
      } catch {
        open = false // the page went away; join state is persisted anyway
      }
    }
    const close = (): void => {
      open = false
      try {
        port.disconnect()
      } catch {
        // already gone
      }
    }
    const fail = (code: BridgeErrorCode): void => post(envelope('error', { code }))

    if (!isAllowedSender(port.sender)) {
      fail('bad_origin')
      close()
      return
    }

    const tabId = port.sender?.tab?.id
    if (typeof tabId === 'number') {
      const previous = portsByTab.get(tabId)
      if (previous !== undefined && previous !== port) {
        try {
          previous.disconnect()
        } catch {
          // already gone
        }
      }
      portsByTab.set(tabId, port)
    }
    port.onDisconnect.addListener(() => {
      open = false
      if (typeof tabId === 'number' && portsByTab.get(tabId) === port) portsByTab.delete(tabId)
    })

    const seen = new Map<string, number>()
    let chain: Promise<void> = Promise.resolve()

    async function handle(message: unknown): Promise<void> {
      if (!open) return
      // Re-checked on EVERY inbound message, not only at connect.
      if (!isAllowedSender(port.sender)) {
        fail('bad_origin')
        close()
        return
      }
      if (message === null || typeof message !== 'object' || Array.isArray(message)) {
        fail('invalid_message')
        return
      }
      const m = message as Record<string, unknown>
      if (m.ns !== BRIDGE_NS) {
        fail('invalid_message') // includes the retired flat {type:'alg-join-complete'}
        return
      }
      if (m.v !== BRIDGE_VERSION) {
        fail('unsupported_version')
        close()
        return
      }
      const ts = typeof m.ts === 'string' ? Date.parse(m.ts) : NaN
      if (
        typeof m.type !== 'string' ||
        typeof m.nonce !== 'string' ||
        !NONCE_RE.test(m.nonce) ||
        !Number.isFinite(ts) ||
        m.payload === null ||
        typeof m.payload !== 'object' ||
        Array.isArray(m.payload)
      ) {
        fail('invalid_message')
        return
      }
      const t = now()
      if (t - ts > MAX_MESSAGE_AGE_MS) return // stale: dropped
      for (const [n, at] of seen) if (t - at > NONCE_DEDUP_MS) seen.delete(n)
      if (seen.has(m.nonce)) return // duplicate: ignored
      seen.set(m.nonce, t)

      const payload = m.payload as Record<string, unknown>
      if (m.type === 'hello') await onHello(payload)
      else if (m.type === 'exchange_token') await onExchange(m.nonce, payload)
      else fail('invalid_message')
    }

    async function onHello(p: Record<string, unknown>): Promise<void> {
      if (!isStr(p.invitation_ref) || (p.locale !== undefined && typeof p.locale !== 'string')) {
        fail('invalid_message')
        return
      }
      post(envelope('presence', { ...(await deps.presence()) }))
      const challengeNonce = newNonce()
      const outcome = await deps.hello(p.invitation_ref, challengeNonce)
      if (outcome.kind === 'challenge') {
        post(
          envelope(
            'challenge',
            { attempt_challenge: outcome.attempt_challenge, expires_at: outcome.expires_at },
            challengeNonce,
          ),
        )
      } else {
        post(envelope('result', { ...outcome.result }))
      }
    }

    async function onExchange(nonce: string, p: Record<string, unknown>): Promise<void> {
      if (
        !isStr(p.exchange_token, MAX_EXCHANGE_TOKEN_LENGTH) ||
        !isStr(p.expires_at) ||
        typeof p.challenge_nonce !== 'string' ||
        !NONCE_RE.test(p.challenge_nonce)
      ) {
        fail('invalid_message')
        return
      }
      post(envelope('ack', { nonce_of: nonce }))
      let result: JoinResultPayload
      try {
        result = (await deps.exchange(p.exchange_token, p.challenge_nonce)).result
      } catch {
        result = { status: 'failed', error_code: 'internal' }
      }
      post(envelope('result', { ...result }))
    }

    port.onMessage.addListener((message) => {
      // One message at a time per port, so ack/result ordering is deterministic.
      chain = chain.then(() => handle(message)).catch(() => fail('invalid_message'))
    })
  }

  return { onConnect }
}
