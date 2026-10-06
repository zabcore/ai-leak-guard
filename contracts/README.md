# Pinned Teams Lite contract

`teams-contract.openapi.yaml` is a byte-identical copy of the CANONICAL contract in
**zabcore/teams-onboarding-backend** (repo root), `x-contract-version: 1.1.2`, pinned
together with bridge/1.1.0. Do not edit it here — change it in the backend repo,
then re-pin.

|                                                 |                                                                                |
| ----------------------------------------------- | ------------------------------------------------------------------------------ |
| Source                                          | zabcore/teams-onboarding-backend @ `307bde3a` (`feat/contract-v1.1-canonical`) |
| `teams-contract.openapi.yaml` sha256            | `b3f9f6c27cf0eb90595a81df763993ea88189d1c857b78d5bd1b32c3b59e9009`             |
| `src/shared/generated/teams-contract.ts` sha256 | `fd5241a3c91765fb6110c314ad1ab2320a03491dabeb659eb946ccd778411f5f`             |
| Generator                                       | `openapi-typescript@7.13.0` (`npm run gen:contract-types`)                     |

The generated file is identical to the backend's
`supabase/functions/_shared/generated/teams-contract.ts`, whose `npm run check:types`
proves it matches the YAML. `tests/teams-contract-openapi.test.ts` fails if either
pinned file changes without updating these hashes, or if the extension's runtime
error list diverges from the YAML enum.

Re-pin: copy the YAML from the backend at the new commit, run
`npm run gen:contract-types`, update the table above and the hashes in the test.
