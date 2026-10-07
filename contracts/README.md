# Pinned Teams Lite contract

`teams-contract.openapi.yaml` is a byte-identical copy of the CANONICAL contract in
**zabcore/teams-onboarding-backend** (repo root), `x-contract-version: 1.6.0`, pinned
together with bridge/1.1.0. Do not edit it here — change it in the backend repo,
then re-pin.

|                                                 |                                                                               |
| ----------------------------------------------- | ----------------------------------------------------------------------------- |
| Source                                          | zabcore/teams-onboarding-backend @ `7dcda04` (`feat/contract-v1.1-canonical`) |
| `teams-contract.openapi.yaml` sha256            | `cb60330592955c4e365efe716a1ddd7dc2339ec5ebee274687d9e6704a0e2b5a`            |
| `src/shared/generated/teams-contract.ts` sha256 | `620ed0423305cdb082faeec2797cd7af61395080155475cf3ea61a4a4967ba46`            |
| Generator                                       | `openapi-typescript@7.13.0` (`npm run gen:contract-types`)                    |

The generated file is identical to the backend's
`supabase/functions/_shared/generated/teams-contract.ts`, whose `npm run check:types`
proves it matches the YAML. `tests/teams-contract-openapi.test.ts` fails if either
pinned file changes without updating these hashes, or if the extension's runtime
error list diverges from the YAML enum.

Re-pin: copy the YAML from the backend at the new commit, run
`npm run gen:contract-types`, update the table above and the hashes in the test.
