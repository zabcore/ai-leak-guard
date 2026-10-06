# Teams Lite — direct-clinic milestone: extension track status

Mirror of the task record in `zabcore/teams-onboarding-backend`
`docs/milestone-direct-clinic.md`, which also holds the backend inventory and the A3 email
analysis. PR #80 stays unmerged.

| Task                                                                                                                       | Owner  | Commit(s)                              | Depends on                               | Result                                                                                                                                                              |
| -------------------------------------------------------------------------------------------------------------------------- | ------ | -------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1 lost-`/join`-response integration test                                                                                  | Claude | `02a5a05` (+ backend `39405e1`)        | backend `tests/it/join-fixture.mjs`      | **PASS**: 3/3 with the backend handlers + Postgres, and 3/3 with the full local Supabase stack. A mutation (discarding the attempt on a network failure) is caught. |
| B2 review `6123a50` → head                                                                                                 | Claude | review only                            | —                                        | **No effect on the tested flow.**                                                                                                                                   |
| B4 contract v1.1.2 + bridge notes current (re-pinned to v1.2.0 for the portal slice, backend `f841253`; no runtime change) | Claude | `db7b415`, bridge notes in this commit | Dot deploys backend `0008` + `join-init` | Pinned byte-identical to the backend. CI is green.                                                                                                                  |

## B1

- Test: `tests/integration/teams-join-lost-response.it.test.ts`.
- Run with `npm run test:it:join`, or add `-- --live` for the Docker local stack. Set `TEAMS_BACKEND_DIR` if the backend checkout is not at `../teams-onboarding-backend`.
- In the regular `npm test` the integration cases are skipped. The guard test always runs: no `src/` file may reference the fixture or a response-drop hook.
- The fault is a `fetch` wrapper in the test file. No build contains a fault switch.

## B2 — `6123a50` (the tested build, `1.3.6 test-join 6123a50`) → PR head

| Commit    | Change                                                                                             | Affects the tested onboarding/bridge flow?                                                                                                           |
| --------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `db7b415` | Contract re-pin to v1.1.2: YAML, generated types (`JoinInitResponse.expires_at`), pin test, README | **No.** The extension never calls `/join-init`, and nothing in `src/` reads `JoinInitResponse` (only `Error['error']` is used, and it is unchanged). |
| `764fa07` | Tests only: a new hello on an enrolled install                                                     | **No.** Tests only.                                                                                                                                  |
| `02a5a05` | B1 integration test, runner script, `test:it:join`                                                 | **No.** Tests and scripts only; no `src/` change.                                                                                                    |

The diff `6123a50..head` touches no file under `src/` except the generated contract types, and no file in `manifest.json`, `public/` or the build scripts. The test build `1.3.6 test-join 6123a50` is therefore still the build under acceptance, and no rebuild is needed. Re-exercised anyway: the full suite and B1 against a real backend (above).
