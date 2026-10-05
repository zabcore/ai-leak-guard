# Pinned Teams Lite contract

`teams-contract.openapi.yaml` is a byte-identical copy of the CANONICAL contract in
**zabcore/teams-onboarding-backend** (repo root), `x-contract-version: 1.1.1`, pinned
together with bridge/1.1.0. Do not edit it here — change it in the backend repo,
then re-pin.

|                                                 |                                                                                |
| ----------------------------------------------- | ------------------------------------------------------------------------------ |
| Source                                          | zabcore/teams-onboarding-backend @ `e15663ef` (`feat/contract-v1.1-canonical`) |
| `teams-contract.openapi.yaml` sha256            | `6545402286d5223d8086a9e26c908dcf457ee542ae8a63bf6a9912addf9ceb84`             |
| `src/shared/generated/teams-contract.ts` sha256 | `60ca401088ddc5ce6c4774197957db5170ebcfea1248c10cebb3825ce3f5215c`             |
| Generator                                       | `openapi-typescript@7.13.0` (`npm run gen:contract-types`)                     |

The generated file is identical to the backend's
`supabase/functions/_shared/generated/teams-contract.ts`, whose `npm run check:types`
proves it matches the YAML. `tests/teams-contract-openapi.test.ts` fails if either
pinned file changes without updating these hashes, or if the extension's runtime
error list diverges from the YAML enum.

Re-pin: copy the YAML from the backend at the new commit, run
`npm run gen:contract-types`, update the table above and the hashes in the test.
