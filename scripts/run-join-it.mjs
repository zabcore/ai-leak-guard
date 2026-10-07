// B1: run the lost-/join-response integration test against a REAL backend.
//
//   npm run test:it:join            backend = the backend repo's edge handlers +
//                                   a throwaway Postgres with its migrations
//   npm run test:it:join -- --live  backend = a throwaway local Supabase stack
//                                   (Kong, Auth, PostgREST, Deno edge runtime;
//                                   needs Docker)
//
// The backend checkout comes from TEAMS_BACKEND_DIR (default:
// ../teams-onboarding-backend, with its `npm ci` done). Its
// tests/it/join-fixture.mjs starts the backend, seeds an org + invitation, and
// runs this repo's integration test with TEAMS_IT_* in env.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BACKEND = resolve(ROOT, process.env.TEAMS_BACKEND_DIR ?? '../teams-onboarding-backend')
const FIXTURE = join(BACKEND, 'tests', 'it', 'join-fixture.mjs')
if (!existsSync(FIXTURE)) {
  console.error(`[join-it] ${FIXTURE} not found — set TEAMS_BACKEND_DIR to the backend checkout.`)
  process.exit(2)
}

const test = [
  process.execPath,
  join(ROOT, 'node_modules', 'vitest', 'vitest.mjs'),
  'run',
  '--root',
  ROOT,
  'tests/integration/teams-join-lost-response.it.test.ts',
]
const fixture = [FIXTURE, '--', ...test]
const argv = process.argv.includes('--live')
  ? [join(BACKEND, 'tests', 'live', 'run-live.mjs'), process.execPath, ...fixture]
  : fixture

const r = spawnSync(process.execPath, argv, { cwd: BACKEND, stdio: 'inherit' })
process.exit(r.status ?? 1)
