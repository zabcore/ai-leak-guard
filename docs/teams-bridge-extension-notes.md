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

**Error.error enum (contract v1.1.1, unchanged in v1.1.2):** `invalid_token | invalid_proof | exhausted | expired |
token_revoked | install_revoked | recovery_window_expired | wrong_recipient | invitation_revoked |
invitation_expired | invitation_consumed`. The bare value `revoked` is gone. `wrong_recipient` is a
`/join-init` (website) answer; the extension never receives it.

**Invariant 3:** every sub-code below is handled distinctly, and none but `install_revoked` is treated
as an install revocation. Tests: `tests/teams-contract.test.ts` ("each 410 sub-code maps to itself")
and `tests/teams-join.test.ts` ("INVARIANT 3: … → its own handling").

| Endpoint     | Status | `error`                                                             | Extension behaviour                                                                |
| ------------ | ------ | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `/provision` | 404    | `invalid_token`                                                     | terminal                                                                           |
| `/provision` | 409    | `exhausted`                                                         | terminal                                                                           |
| `/provision` | 410    | `token_revoked`                                                     | terminal; **no** re-enroll block (a rotated token may enroll)                      |
| `/provision` | 410    | `install_revoked`                                                   | terminal; sets the persistent re-enroll block                                      |
| `/provision` | 410    | `expired` / `recovery_window_expired`                               | terminal                                                                           |
| `/join`      | 401    | `invalid_proof`                                                     | terminal for this attempt; a new `hello` may start a fresh one                     |
| `/join`      | 410    | `expired`                                                           | **recoverable**: SAME attempt kept, dead token dropped; the page mints a new token |
| `/join`      | 410    | `invitation_revoked` / `invitation_expired` / `invitation_consumed` | terminal; invitation remembered as dead, never retried; **no** block               |
| `/join`      | 410    | `recovery_window_expired`                                           | terminal; invitation remembered as dead                                            |
| `/join`      | 410    | `install_revoked`                                                   | terminal; sets the re-enroll block; invitation remembered as dead                  |

An unrecognized 410 is treated as `expired` (recoverable within the window, never a block, never a
dead invitation).
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
  `challenge {attempt_challenge, expires_at}` as a separate message. The challenge envelope's nonce is
  persisted on the attempt **before** it is posted.
- **`exchange_token {exchange_token, expires_at, challenge_nonce}`:** the extension acks, then
  calls `/join`, then posts the result. `exchange_token` and `expires_at` are the `/join-init` 200
  body's values, forwarded verbatim (contract v1.1.2: `expires_at` is ISO 8601 UTC, ~2 min).
  - `challenge_nonce` must equal the nonce of a `challenge` this extension emitted for the current
    attempt or a settled one.
  - Anything else → `failed recovery_window_expired`, and `/join` is never called.
- **`result`:** success is `{status: "success", connected_invitation_ref, connected_attempt_challenge,
connected_org_id, connected_org_name, connected_at}`; failure is `{status: "failed", error_code}`.
- **Never on the port:** the attempt secret, the idempotency key and the install credential.

### Ruled values (bridge/1.1.0 §3 / §5 / §5.1)

1. **`presence.state`** (pinned §3): `idle | awaiting_token | connecting | connected | error`.

   | State            | When                                                                                                                  |
   | ---------------- | --------------------------------------------------------------------------------------------------------------------- |
   | `connected`      | enrolled                                                                                                              |
   | `connecting`     | an attempt whose `exchange_token` was sent (in flight, or awaiting lost-response recovery)                            |
   | `awaiting_token` | an attempt whose challenge is out, no token yet                                                                       |
   | `error`          | install revoked (persistent block), or the last join failed within the 10-min window and nothing newer is in progress |
   | `idle`           | otherwise                                                                                                             |

2. **`result.status`:** `success | failed`.
3. **`result.error_code`** (§5 vocabulary):
   - Contract codes: `invalid_proof`, `expired`, `install_revoked`, `recovery_window_expired`,
     `invitation_revoked`, `invitation_expired`, `invitation_consumed`.
   - `backend_unavailable` (retryable: resend the token; a lost response maps here too).
   - `already_enrolled`, `join_pending`, `not_configured`, `internal_error`.
4. **Nonce dedup** is per port.
5. **Attempt lifetime (§5.1):** `challenge.expires_at` = attempt creation + 10 min, the attempt lifetime
   the website displays. The backend's `exchange_token.expires_at` stays 2 min, and recovery-first is
   driven by the exchange token and attempt state within the window.
   - An attempt whose `exchange_token` was never sent may be superseded by a new `hello` once it ages
     out, or by a `hello` for another invitation.
   - An attempt whose token **was** sent is never replaced. A reconnect re-emits its SAME challenge.
6. **Fresh attempts after a failure:**
   - The original attempt stays replayable under its `challenge_nonce`.
   - A retry of a completed or lost-response join recovers the existing credential (recovery-ordering),
     never a fresh attempt:
     - a successful join re-emits its challenge on `hello` for the same invitation within the window;
     - an in-flight attempt is resent as-is.
   - `install_revoked`, `recovery_window_expired` and the v1.1.1 invitation-dead codes
     (`invitation_revoked` / `invitation_expired` / `invitation_consumed`) never yield a fresh attempt.
     The extension refuses the retry itself; only authorized recovery (for an install) can lift it.
     - The invitation is remembered durably, beyond the replay window, and the failure is answered again.
     - A revoked install (persistent block) gets `failed install_revoked` for any invitation.
   - A lapsed exchange token (`expired`) is recovered with the SAME attempt: the dead token is dropped,
     the reconnect re-emits the same challenge, and the page mints a new token for it.
   - A new attempt for the same invitation is possible only after `invalid_proof`, and only when the
     page sends a new `hello`. The extension never starts one on its own. The backend stays the final
     guard against double redemption.
   - Already enrolled → `failed already_enrolled` (the connected clinic is never switched). An
     in-flight attempt for a different invitation → `failed join_pending`.

### Invariant 4 — enrollment conflicts are enforced at the store

Every freshly issued credential (join, managed provision, code-entry enroll) is stored through
`commitEnrollment` (`src/shared/teams-storage.ts`). It refuses to overwrite a different install's
enrollment: the existing enrollment is kept, and the producer reports `already_enrolled`. Re-storing
the same install (a recovered credential) is allowed, and commits are serialized. The website's result
binding guards the display; this guards the store.

Tests: `tests/teams-enrollment-guard.test.ts`:

- the store itself;
- an enrollment landing during `/join`, provisioning or code entry;
- competing join tabs: a superseded tab's token never reaches `/join`, a second invitation never
  switches the clinic, and an in-flight tab gets `join_pending` while the reconnect reuses the
  original attempt.

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
