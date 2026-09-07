# V1.3 Regression Matrix (brief §9)

Every row of the V1.3 send-protection regression matrix mapped to the
test(s) that prove it. This is the artefact the store submission and the
compatibility monitor cite. It is **verification only** — M6 added no
product behaviour; it consolidated and gap-filled coverage.

- **Sites:** ChatGPT (`chatgpt`), Claude (`claude`), Gemini (`gemini`).
- **Flag:** the committed `SUBMIT` flag is **OFF** in `main`; the submit
  path is exercised in tests via injected seams.
- Test names below are the real `it(...)` strings. "×3 sites" means the
  three adapter suites each carry the row.
- **GAP** rows are documented coverage gaps (Q7 programmatic paths). They
  are pinned as **NOT** intercepted so the coverage claim stays honest.

## Text

| Row                                                             | Test                                                                                                                                                                                         |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Typed PHI → warn at send                                        | `submit-core.test.ts` › _proceed → exactly one submit, ack cleared on send, as-is logged_; ×3 `submit-*-adapter.test.ts` › _proceed → one click; return-to-edit → zero clicks, draft intact_ |
| Pasted PHI → early (paste-time) warning                         | `paste-richtext.test.ts` › _html-only payload with an SSN → detection fires_; `paste-flow.test.ts` › _counts and shows a toast when insertion succeeds_                                      |
| Paste-then-type-more → combined result at send                  | `regression-matrix.test.ts` › _paste-then-type-more → the COMBINED composer text is scanned at send_ (×3)                                                                                    |
| Clean typed → sends, no modal                                   | `submit-core.test.ts` › _auto-proceeds with no decision UI and one resume() call_; ×3 › _clean Enter → exactly one send-button click_                                                        |
| Injected / autocompleted text → detected at send                | `regression-matrix.test.ts` › _injected / autocompleted text (programmatic set, no input event) → detected at send_ (×3)                                                                     |
| Simulated dictation (programmatic value set) → detected at send | `regression-matrix.test.ts` › _simulated dictation (programmatic value set) → detected at send_ (×3)                                                                                         |

## Carry-forward (A-7, blocker §10.12) — V1.2.1 rich-text/EMR paste still fires at PASTE time

| Row                                                    | Test                                                                                           |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| HTML-only EMR-shape (no plain-text) with SSN           | `paste-richtext.test.ts` › _SSN in `<span>SSN</span><span>123-45-6789</span>` is now detected_ |
| …with MRN                                              | › _MRN in `<span>Medical record number</span><span>MRN 12345678</span>` is now detected_       |
| …with NPI (checksum-valid)                             | › _NPI in `<span>NPI</span><span>1234567893</span>` is now detected (checksum-valid)_          |
| Multi-row fragment → SSN+MRN+NPI un-glued in one paste | › _multi-row EMR-shape fragment → SSN, MRN, NPI all detected in a single paste_                |

`tests/paste-richtext.test.ts` stays green and unweakened (M6 changed nothing in it).

## Send interaction

| Row                                                                  | Test                                                                                                                                                            |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Enter → scan                                                         | ×3 `submit-*-adapter.test.ts` › _Enter … → intent → preventDefault + … scan_                                                                                    |
| Send-button click → scan                                             | ×3 › _send-button click → intent → preventDefault + … scan_                                                                                                     |
| Shift+Enter → newline (never scanned)                                | ×3 › _Shift+Enter → … no intent_                                                                                                                                |
| IME (`isComposing` OR `keyCode 229`) → NEVER intercepted             | ×3 › _IME composing Enter (isComposing) → never intercepted_ + _IME confirm Enter (keyCode 229) → never intercepted_                                            |
| Ctrl/Cmd+Enter per the M0 binding                                    | `regression-matrix.test.ts` › _Ctrl+Enter and Cmd+Enter → intercepted per the M0 binding (send intent)_ (×3)                                                    |
| Cancel → draft preserved                                             | `submit-core.test.ts` › _return-to-edit → zero submits, draft intact, cancelled logged_; ×3 › _…return-to-edit → zero clicks, draft intact_                     |
| Proceed → EXACTLY ONE submission                                     | `submit-core.test.ts` › _proceed → exactly one submit…_; ×3 › _…proceed → one click…_                                                                           |
| Repeated Enter → no duplicate submit                                 | `submit-core.test.ts` › _two intents during HELD → one submission…_; ×3 › _rapid double-Enter → coalesced → … one click_                                        |
| Rapid double-click → no duplicate                                    | `submit-core.test.ts` › _two intents during DECISION → one submission after proceed_ (idempotent resume; the same coalescing covers a double send-button click) |
| **GAP** — programmatic send from a suggestion chip → NOT intercepted | `regression-matrix.test.ts` › _DOCUMENTED GAP: a programmatic suggestion-chip click is NOT intercepted_ (×3)                                                    |

## Acknowledgement / dedup

| Row                                                        | Test (`submit-core.test.ts`)                                                                                                                                                                                                   |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Acked + unchanged → no re-warn (within the unsent message) | _within one unsent message, an acknowledged fingerprint suppresses the second identical warn (modal skipped)_                                                                                                                  |
| Modified risk shape → fresh scan/warn                      | _a changed count re-warns…_ + _a changed category re-warns within an unsent message_                                                                                                                                           |
| Added PHI → warns                                          | _a changed count re-warns within an unsent message, and reports the change_                                                                                                                                                    |
| Confirmed send clears ack (+ doc gate)                     | _#1 proceed → SUBMITTED → the acknowledgement is cleared_; _#2 a new same-shape message after a send RE-WARNS_; M4: `submit-text-file-coordination.test.ts` › _confirmed send clears the doc gate (next message re-evaluates)_ |

## Files (M4) — all `submit-text-file-coordination.test.ts`

| Row                                                           | Test                                                                                                                      |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Clean + clean → sends                                         | _clean text + clean file ⇒ no modal, sends_                                                                               |
| Clean file + sensitive text → one modal                       | _clean file + sensitive text ⇒ one modal (text only)_                                                                     |
| Sensitive file + clean text → one modal                       | _sensitive file + clean text ⇒ one modal (file only), proceed acks + sends_                                               |
| Both flagged → ONE combined modal (blocker §10.6)             | _sensitive text + sensitive file ⇒ exactly ONE combined modal_ + _text + file ⇒ ONE modal, merged heading + summed count_ |
| Scan-pending + immediate send → holds then settles            | _file scan pending at send ⇒ holds until settle, no submit before settle_                                                 |
| Pending exceeds watchdog → fail-open + logs unable-to-inspect | _file scan pending exceeds watchdog ⇒ fail open: sends + logs unable-to-inspect, no hang_                                 |
| Completed unable-to-inspect → decision (never silently sent)  | _unable-to-inspect file + clean text ⇒ modal; proceed sends once_ + _…return-to-edit sends nothing, gate untouched_       |
| Multiple files                                                | _multiple files, ≥1 detected ⇒ one combined modal, fileCount reflects count_                                              |

## Fail-open (§2, A-1) — `submit-core.test.ts`

| Row                                                                                               | Test                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scan throws → proceeds + logs incomplete                                                          | _scan throws synchronously_ / _scan rejects asynchronously_ / _readComposerText throws_                                                                                                                                                                  |
| Exceeds watchdog → proceeds                                                                       | _a scan that never resolves is cut off at SCAN_WATCHDOG_MS and the send proceeds_                                                                                                                                                                        |
| Very large composer (cap/watchdog per A-4) → no silent unprotected fall-through beyond the budget | Time-bounded by Watchdog-A (no character cap); same _…cut off at SCAN_WATCHDOG_MS…_ test — a slow/huge read fails open and logs `unable-to-inspect`, never a silent pass                                                                                 |
| Adapter fails resume ≥ kill threshold → kill switch + popup notice                                | _engages at RESUME_FAILURE_KILL_THRESHOLD, reports the adapter, and stops taking sends_ + _default reportAdapterDisabled writes ONLY {adapterId, ts} to storage_; ×3 › _kill-switch disabled → native send restored_                                     |
| Composer re-renders between hold and resume → still resolves                                      | `regression-matrix.test.ts` › _composer re-renders between hold and resume → resume still resolves and submits once_ (×3)                                                                                                                                |
| Extension disabled/reloaded mid-hold → never permanently stuck                                    | ×3 › _master toggle OFF → no interception_ + _flag OFF → no interception_ (native send restored; the held decision has no auto-send and the user can always cancel → draft kept)                                                                         |
| **A-1**: no DECISION-phase timer/failure auto-submits flagged content                             | _with the user never choosing, advancing past every budget leaves the send HELD with zero submissions_; _if a liveness guard is enabled, its ONLY outcome is RETURNED_TO_EDIT_; _a throw inside the decision UI lands on RETURNED_TO_EDIT, not a submit_ |

## Self-test (M5 / M5.1)

| Row                                                   | Test                                                                                                                                                                        |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Draft never destroyed                                 | `self-test-runner.test.ts` › _DRAFT_PRESENT: refuses to run over an existing draft_; `self-test-integration.test.ts` › _never overwrites an existing draft…_                |
| Nothing ever submitted                                | `self-test-runner.test.ts` › _never submits: no seam can proceed…_; `self-test-integration.test.ts` › _confirmed: real interception + modal, resume NEVER called…_          |
| Correct result: supported / unsupported / failed-init | `self-test-runner.test.ts` › _NO_INTERCEPT… → unsupported_ / _NO_COMPOSER… → fail_ / _NO_MODAL… → fail_; `self-test-banner.test.ts` + `self-test-popup.test.ts` copy        |
| Active-tab preference + per-site chooser              | `self-test-popup.test.ts` › _pickSelfTestSitePreferringActive (M5.1)_ + _selfTestSiteForId / selectedSelfTestSite_ + _startSelfTest opens a fresh tab of the SELECTED site_ |

## Security (§8) — see also `docs/RELEASE_BLOCKERS_M6.md`

| Row                                      | Test / gate                                                                                                                                                                                                                          |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Zero programmatic outbound network       | `npm run verify:no-network` (scans `dist/`)                                                                                                                                                                                          |
| Permissions unchanged (`["storage"]`)    | `manifest-permissions.test.ts` › _permissions list is exactly ["storage"]…_                                                                                                                                                          |
| No raw values/content stored or logged   | `event-log.test.ts` › _storage.set never receives a value/text/name/filename key…_; `submit-core.test.ts` › _no logged event carries raw composer text…_ + _RELEASE BLOCKER: chrome.storage.local.set never receives a fingerprint…_ |
| document-gate holds no content/filenames | `regression-matrix.test.ts` › _a settled snapshot carries only metadata fields…_                                                                                                                                                     |

## Documented coverage GAPS (Q7 — NOT intercepted, by design)

Programmatic send paths that bypass BOTH Enter and the send button are
**out of scope** and are NOT claimed as caught. Per site (from each
adapter's header + `ARCHITECTURE.md`):

- **ChatGPT** — suggestion chips, Regenerate/Try again, edit-and-resend, Voice auto-submit, Continue generating.
- **Claude** — suggested/example chips, Retry (incl. model switch), edit-and-resend, Projects/template quick actions.
- **Gemini** — suggestion chips, regenerate/modify-response/show-more-drafts, Gemini Live/voice auto-submit, Deep Research "Start research"/canvas actions, edit-and-resend.
- **Gemini locale** — a _button-click_ send in a non-English UI relies on `gem-icon-button.send-button button` (locale-independent, closed at M5); Enter-to-send is locale-safe everywhere.

The chip case is pinned NOT-intercepted by `regression-matrix.test.ts` ›
_DOCUMENTED GAP: a programmatic suggestion-chip click is NOT intercepted_.
