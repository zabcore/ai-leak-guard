# Pinned Teams Lite contract

`teams-contract.openapi.yaml` is a byte-identical copy of the CANONICAL contract in
**zabcore/teams-onboarding-backend** (repo root), `x-contract-version: 1.4.0`, pinned
together with bridge/1.1.0. Do not edit it here — change it in the backend repo,
then re-pin.

|                                                 |                                                                                |
| ----------------------------------------------- | ------------------------------------------------------------------------------ |
| Source                                          | zabcore/teams-onboarding-backend @ `2554b9c ` (`feat/contract-v1.1-canonical`) |
| `teams-contract.openapi.yaml` sha256            | `aee4275d3acccc84f3ec0d5e85edd1543150835d426cefc10753764e8fd3c4c9`             |
| `src/shared/generated/teams-contract.ts` sha256 | `37cbfda91dece2a44c469047079fb318cd8aba5392d634e92f5a15b9a1454813`             |
| Generator                                       | `openapi-typescript@7.13.0` (`npm run gen:contract-types`)                     |

The generated file is identical to the backend's
`supabase/functions/_shared/generated/teams-contract.ts`, whose `npm run check:types`
proves it matches the YAML. `tests/teams-contract-openapi.test.ts` fails if either
pinned file changes without updating these hashes, or if the extension's runtime
error list diverges from the YAML enum.

Re-pin: copy the YAML from the backend at the new commit, run
`npm run gen:contract-types`, update the table above and the hashes in the test.
