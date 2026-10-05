# Pinned Teams Lite contract

`teams-contract.openapi.yaml` is a byte-identical copy of the CANONICAL contract in
**zabcore/teams-onboarding-backend** (repo root), `x-contract-version: 1.1.0`, pinned
together with bridge/1.1.0. Do not edit it here — change it in the backend repo,
then re-pin.

|                                                 |                                                                               |
| ----------------------------------------------- | ----------------------------------------------------------------------------- |
| Source                                          | zabcore/teams-onboarding-backend @ `e2cd5473eea63179b7cac060925265c650985715` |
| `teams-contract.openapi.yaml` sha256            | `4adc678b1efa5d9d463a0f90ef9daff9235249d334922714e24713e144cf736a`            |
| `src/shared/generated/teams-contract.ts` sha256 | `5322a005283c33bfd6e0e3d28b8ab295e331b17b5e590443a39c6e20a6014230`            |
| Generator                                       | `openapi-typescript@7.13.0` (`npm run gen:contract-types`)                    |

The generated file is identical to the backend's
`supabase/functions/_shared/generated/teams-contract.ts`, whose `npm run check:types`
proves it matches the YAML. `tests/teams-contract-openapi.test.ts` fails if either
pinned file changes without updating these hashes, or if the extension's runtime
error list diverges from the YAML enum.

Re-pin: copy the YAML from the backend at the new commit, run
`npm run gen:contract-types`, update the table above and the hashes in the test.
