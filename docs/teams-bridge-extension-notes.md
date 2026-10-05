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
  `bckodcaijicfnkblnfdkkloemfpbekhg`. The website's `chrome.runtime.sendMessage(<id>, …)`
  allowlist must include both IDs in any environment that uses the test build.
- **C2 — minimum version for presence:** the join handoff is not in any released version yet
  (`manifest.json` is 1.3.6). Proposed: **1.4.0** is the first version that has
  `externally_connectable` and the handoff, bumped at release time. There is no separate
  presence/version message yet. If the bridge defines one, the extension will add it.
- **C3 — scope:** there is **no content script on zabcore.com**. The page talks to the extension
  directly through `externally_connectable`, now limited to `https://zabcore.com/join*`. The handler
  also requires the sender page URL to be on that origin under `/join`.
- **C4 — ack on `exchange_token`:** today `alg-join-complete` answers once, after `/join`
  settles, with `{ ok: true, outcome: "enrolled" }` or `{ ok: false, error }`. The token is
  persisted before the request. A separate immediate acknowledgement is **not implemented**
  and needs its message shape from the bridge doc.
- **C5 — replay for the 10-minute window:** **not implemented** as a replay. If the response is
  lost, the extension retries the same attempt and the backend returns the existing credential
  within the window. A repeated `complete` after success currently answers
  `{ ok: false, error: "already-enrolled" }`. If the bridge requires replaying
  `{ ok: true, outcome: "enrolled" }` for 10 minutes, that is a small follow-up.
- **C6 — attempt_secret persistence:** stored in `chrome.storage.local` with no expiry, so it
  always outlasts the recovery window. It is discarded only on success or a terminal backend
  answer (`invalid_proof`, `expired`, `install_revoked`, `recovery_window_expired`). It is kept
  on network errors, disconnects, service-worker teardown and browser restart. The extension has
  no authorized-recovery path yet; see below.

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
   - (b) the zabcore `/join*` page hands the grant to the extension over the existing handoff.
4. **Extension:** on a valid grant, it redeems it at the backend, stores the new credential and
   clears its local re-enroll block (`clearRevokeBlock()`, the only code path allowed to clear it).
   Nothing else clears the block: not token rotation, not Activate, not unenroll.
