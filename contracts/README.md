# Pinned Teams Lite contract

`teams-contract.openapi.yaml` is a byte-identical copy of the CANONICAL contract in
**zabcore/teams-onboarding-backend** (repo root), `x-contract-version: 1.2.0`, pinned
together with bridge/1.1.0. Do not edit it here — change it in the backend repo,
then re-pin.

|                                                 |                                                                                |
| ----------------------------------------------- | ------------------------------------------------------------------------------ |
| Source                                          | zabcore/teams-onboarding-backend @ `f8412536` (`feat/contract-v1.1-canonical`) |
| `teams-contract.openapi.yaml` sha256            | `9941dcefdb60a1428780b53bfe537626cd28ab817d1c10413dc0efc5d542da1d`             |
| `src/shared/generated/teams-contract.ts` sha256 | `c8672ca20f0e3fbe04426c6f433f9a24537fbbe566901d1b47421d56676a2268`             |
| Generator                                       | `openapi-typescript@7.13.0` (`npm run gen:contract-types`)                     |

The generated file is identical to the backend's
`supabase/functions/_shared/generated/teams-contract.ts`, whose `npm run check:types`
proves it matches the YAML. `tests/teams-contract-openapi.test.ts` fails if either
pinned file changes without updating these hashes, or if the extension's runtime
error list diverges from the YAML enum.

Re-pin: copy the YAML from the backend at the new commit, run
`npm run gen:contract-types`, update the table above and the hashes in the test.
