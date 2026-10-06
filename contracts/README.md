# Pinned Teams Lite contract

`teams-contract.openapi.yaml` is a byte-identical copy of the CANONICAL contract in
**zabcore/teams-onboarding-backend** (repo root), `x-contract-version: 1.3.0`, pinned
together with bridge/1.1.0. Do not edit it here — change it in the backend repo,
then re-pin.

|                                                 |                                                                                |
| ----------------------------------------------- | ------------------------------------------------------------------------------ |
| Source                                          | zabcore/teams-onboarding-backend @ `ab64ad4a` (`feat/contract-v1.1-canonical`) |
| `teams-contract.openapi.yaml` sha256            | `6d3992fbc5528bedca722ff8ba065ddf08eb7da96c134adfd6f954dfb45ad0d3`             |
| `src/shared/generated/teams-contract.ts` sha256 | `ec47cf5c320cedf709ffbf8d6f3993e0225f7ca1589688e4bb7236704121f73c`             |
| Generator                                       | `openapi-typescript@7.13.0` (`npm run gen:contract-types`)                     |

The generated file is identical to the backend's
`supabase/functions/_shared/generated/teams-contract.ts`, whose `npm run check:types`
proves it matches the YAML. `tests/teams-contract-openapi.test.ts` fails if either
pinned file changes without updating these hashes, or if the extension's runtime
error list diverges from the YAML enum.

Re-pin: copy the YAML from the backend at the new commit, run
`npm run gen:contract-types`, update the table above and the hashes in the test.
