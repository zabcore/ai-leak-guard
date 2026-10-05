# Teams Lite — extension side of bridge/1.1.0

What the extension (PR #80, branch `feat/teams-deploy-m1`) implements against
`bridge/1.1.0`, and what the backend and website must match.

## Pinned values (all three parties must match)

**idempotency_key**, domain-separated so it never equals the S256 `attempt_challenge`
(= `base64url(SHA-256(attempt_secret))`, untagged):

| Endpoint     | Derivation                                                            | Test value for `"abc"`                        |
| ------------ | --------------------------------------------------------------------- | --------------------------------------------- |
| `/provision` | `base64url_nopad(SHA-256(UTF-8("alg-provision-idem:" + attempt_id)))` | `3Ih5gPY5claPtZn3TrQSYK_TOWgz9e7F2bWN6kSr4Sc` |
| `/join`      | `base64url_nopad(SHA-256(UTF-8("alg-join-idem:" + attempt_secret)))`  | `wr9yGO-HiZXg5IzUjNEDFiwwcz4jZ7JWPpqs3nYdROc` |

The key is re-derived on every request, so a retry of the same attempt always
carries the same key. Source: `src/shared/teams-contract.ts`
(`deriveIdempotencyKey`, `IDEMPOTENCY_DOMAIN_TAGS`).

**Error.error enum:** `invalid_token | invalid_proof | exhausted | expired |
token_revoked | install_revoked | recovery_window_expired`. The bare value `revoked` is gone.

| Endpoint     | Status | `error`                               | Extension behaviour                                           |
| ------------ | ------ | ------------------------------------- | ------------------------------------------------------------- |
| `/provision` | 404    | `invalid_token`                       | terminal                                                      |
| `/provision` | 409    | `exhausted`                           | terminal                                                      |
| `/provision` | 410    | `token_revoked`                       | terminal; **no** re-enroll block (a rotated token may enroll) |
| `/provision` | 410    | `install_revoked`                     | terminal; sets the persistent re-enroll block                 |
| `/provision` | 410    | `expired` / `recovery_window_expired` | terminal                                                      |
| `/join`      | 401    | `invalid_proof`                       | terminal                                                      |
| `/join`      | 410    | `expired` / `recovery_window_expired` | terminal                                                      |
| `/join`      | 410    | `install_revoked`                     | terminal; sets the re-enroll block                            |

An unrecognized 410 is treated as `expired`: terminal, and it never sets the block.
Any other status, or a network failure, is retried with the same attempt.

## C1–C6 (extension-side confirmations)

- **C1 — production Chrome Web Store ID:** `ebknkkimodbdplohbgpgglmppokedfdp`, as recorded in
  `src/growth/constants.ts` (the CWS reviews link). The self-hosted test build has a different, fixed ID:
  `bckodcaijicfnkblnfdkkloemfpbekhg`. The website's `chrome.runtime.connect(<id>, { name: "zc.join.v1" })`
  target must include both IDs in any environment that uses the test build.
- **C2 — minimum version for presence:** the join handoff is not in any released version yet
  (`manifest.json` is 1.3.6). Proposed: **1.4.0** is the first version that has
  `externally_connectable` and the handoff, bumped at release time. There is no separate
  presence/version message yet. If the bridge defines one, the extension will add it.
- **C3 — scope:** there is **no content script on zabcore.com**. The page talks to the extension
  directly through `externally_connectable`, now limited to `https://zabcore.com/join*`. The handler
  also requires the sender page URL to be on that origin under `/join`.
- **C4 — ack on `exchange_token`:** implemented. The extension posts `ack { nonce_of }` (the
  `exchange_token` envelope's nonce) as soon as the message validates, before it calls `/join`, then
  posts `result`.
- **C5 — result replay:** implemented. A repeat `exchange_token` for the same `challenge_nonce`
  returns the stored `result` for 10 minutes after the join settles, then `recovery_window_expired`.
  A successful join also re-emits its SAME challenge on a new `hello` for that invitation, so a page
  that reconnects can replay its token. Exactly-once is not guaranteed.
- **C6 — attempt_secret persistence:** stored in `chrome.storage.local` with no expiry, so it
  always outlasts the recovery window. It is discarded only on success or a terminal backend
  answer (`invalid_proof`, `expired`, `install_revoked`, `recovery_window_expired`). It is kept
  on network errors, disconnects, service-worker teardown and browser restart. The extension has
  no authorized-recovery path yet; see below.

## Join handoff transport (bridge/1.1.0 §1–§3)

Source: `src/background/teams-join-port.ts` (port server) and `src/enterprise/teams-join.ts`
(`prepareChallenge`, `exchangeJoin`). There is **no** `onMessageExternal` receiver: the one-shot
`{type: "alg-join-complete"}` message is answered with `error {code: "invalid_message"}` and never
reaches `/join`. A test asserts this.

- **Transport:** `chrome.runtime.onConnectExternal`, port name `zc.join.v1`, one port per tab (a new
  port from the same tab closes the old one).
  - The sender must be `https://zabcore.com` on a `/join*` page. This is checked on connect and on
    every inbound message.
  - Otherwise the extension sends `error {code: "bad_origin"}` and closes the port.
- **Envelope:** `{ ns: "zc.join", v: 1, type, nonce, ts, payload }` both ways. Outbound nonces are UUIDv7.
  - Inbound nonces must match `[0-9A-Za-z-]{16,64}` (fits ULID and UUID).
  - A nonce seen on the same port within 60 s is ignored. A message whose `ts` is more than 5 min
    old is dropped.
  - An unsupported `v` gets `unsupported_version` and the port is closed. An unknown `ns`/`type`, or
    a malformed envelope or payload, gets `invalid_message`.
- **`hello {invitation_ref, locale}`:** the extension sends `presence {ext_version, state}`, then
  `challenge {attempt_challenge, expires_at}` as a separate message.
  - The challenge envelope's nonce is persisted on the attempt **before** it is posted.
  - For an in-flight attempt (its token was already sent), a new `hello` re-emits the SAME challenge.
    It never mints a new attempt because the port dropped.
  - Already enrolled → `result {status: "failed", error_code: "already_enrolled"}` and no challenge;
    the connected clinic is never switched.
  - An in-flight attempt for a _different_ invitation → `failed join_pending`.
- **`exchange_token {exchange_token, expires_at, challenge_nonce}`:** the extension acks, then
  calls `/join`, then posts the result.
  - `challenge_nonce` must equal the nonce of a `challenge` this extension emitted for the current
    attempt or a settled one.
  - Anything else → `failed recovery_window_expired`, and `/join` is never called.
- **`result`:** success is `{status: "success", connected_invitation_ref, connected_attempt_challenge,
connected_org_id, connected_org_name, connected_at}`; failure is `{status: "failed", error_code}`.
  - `error_code` is a contract code (`invalid_proof`, `expired`, `install_revoked`,
    `recovery_window_expired`) or one of `network` (retryable: resend the token),
    `already_enrolled`, `join_pending`, `not_configured`, `internal`.
- **Never on the port:** the attempt secret, the idempotency key and the install credential.

**Choices the bridge text leaves open (please confirm):**

1. `presence.state` values: `unenrolled | joining | enrolled`.
2. `result.status` values: `success | failed`.
3. Non-contract `error_code` values, listed above.
4. Dedup is per port.
5. `challenge.expires_at` = attempt creation + 10 min. A stale unsent attempt is replaced on the
   next `hello`; an in-flight one never is.

## Authorized recovery (definition)

Recovery lets an organization bring back a revoked or lost installation **without consuming a
new slot**. It is **never browser-initiated**.

1. **Who:** an org owner or admin, or a delegated MSP acting for that org, in an authenticated
   portal session. An install credential can never trigger recovery.
2. **What the backend does, in one transaction:** for the given `install_id` it
   - reuses the existing slot (`installs_used` unchanged);
   - clears the install's revocation;
   - rotates the credential, so the superseded credential stops working immediately;
   - issues a single-use, short-lived **recovery grant** bound to `{org_id, install_id}`.
     Every action is audit-logged.
3. **Delivery to the browser:** an admin-controlled channel, never something the browser polls
   for. The decision still open is which channel:
   - (a) a recovery-grant value in the managed policy. This needs a schema change, because
     today's `managed_schema` allows only `deploymentToken` and `autoEnroll`;
   - (b) the zabcore `/join*` page hands the grant to the extension over the `zc.join.v1` port.
4. **Extension:** on a valid grant, it redeems it at the backend, stores the new credential and
   clears its local re-enroll block (`clearRevokeBlock()`, the only code path allowed to clear it).
   Nothing else clears the block: not token rotation, not Activate, not unenroll.
