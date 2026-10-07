// Teams Lite — a LOADABLE UNPACKED test build for the direct-clinic join
// acceptance (website <-> extension over the bridge/1.1.0 `zc.join.v1` port).
// NOT a Store build: it only overlays the shipped manifest for the test.
//
//   VITE_TEAMS_BASE_URL=https://<project>.supabase.co \
//   VITE_TEAMS_ANON_KEY=<that project's anon/publishable key> \
//   ALG_ID_KEY=<.pem whose public key fixes the id> | ALG_PUBLIC_KEY=<base64 SPKI> \
//   npm run build:test-join
//
// - Builds with the backend config baked in (the extension's direct /join and
//   /checkin calls go to VITE_TEAMS_BASE_URL; vite adds it to host_permissions).
// - externally_connectable.matches = ["https://zabcore.com/*"] (the port
//   handler still re-checks origin https://zabcore.com and a /join* page).
// - Sets manifest `key` (the PUBLIC key only) so the unpacked build loads with
//   a FIXED id: from ALG_ID_KEY (a .pem; only its public half is written) or
//   ALG_PUBLIC_KEY (e.g. the production item's public key -> its prod id).
// - Writes release/test-join/<id>/ (unpacked, load via chrome://extensions ->
//   Load unpacked) and a .zip of it. Never commit either: release/ is ignored.
import { spawnSync } from 'node:child_process'
import { createHash, createPublicKey } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fail = (m) => {
  console.error(`[build:test-join] ${m}`)
  process.exit(1)
}

const baseUrl = (process.env.VITE_TEAMS_BASE_URL ?? '').trim().replace(/\/+$/, '')
const anonKey = (process.env.VITE_TEAMS_ANON_KEY ?? '').trim()
if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(baseUrl))
  fail('Set VITE_TEAMS_BASE_URL to https://<project>.supabase.co')
if (!anonKey)
  fail(
    'Set VITE_TEAMS_ANON_KEY to the project anon/publishable key (public; never the service-role key).',
  )
if (/service_role/.test(Buffer.from(anonKey.split('.')[1] ?? '', 'base64url').toString())) {
  fail('VITE_TEAMS_ANON_KEY is a SERVICE-ROLE key. Use the anon/publishable key.')
}

let spki
if (process.env.ALG_PUBLIC_KEY) {
  spki = Buffer.from(process.env.ALG_PUBLIC_KEY.trim(), 'base64')
} else if (process.env.ALG_ID_KEY && existsSync(process.env.ALG_ID_KEY)) {
  spki = createPublicKey(readFileSync(process.env.ALG_ID_KEY)).export({
    type: 'spki',
    format: 'der',
  })
} else fail('Set ALG_ID_KEY (a .pem) or ALG_PUBLIC_KEY (base64 SPKI) to fix the extension id.')
const id = [...createHash('sha256').update(spki).digest('hex').slice(0, 32)]
  .map((c) => String.fromCharCode(97 + parseInt(c, 16)))
  .join('')

const build = spawnSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit', env: process.env })
if (build.status !== 0) fail('npm run build failed')

const out = join(ROOT, 'release', 'test-join', id)
rmSync(out, { recursive: true, force: true })
mkdirSync(dirname(out), { recursive: true })
cpSync(join(ROOT, 'dist'), out, { recursive: true })
const manifestPath = join(out, 'manifest.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
manifest.key = spki.toString('base64')
manifest.externally_connectable = { matches: ['https://zabcore.com/*'] }
manifest.name = `${manifest.name} (test join)`
// Distinguishable from the public build of the same version on chrome://extensions.
const sha = spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
  cwd: ROOT,
  encoding: 'utf8',
}).stdout.trim()
manifest.version_name = `${manifest.version} test-join ${sha || 'local'}`
delete manifest.update_url
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')

// Sanity: the bundle must carry the test backend and the port receiver.
const sw = spawnSync('grep', ['-rl', 'zc.join.v1', out], { encoding: 'utf8' }).stdout
const be = spawnSync('grep', ['-rl', baseUrl, out], { encoding: 'utf8' }).stdout
if (!sw.trim()) fail('built bundle has no zc.join.v1 port receiver')
if (!be.trim()) fail('built bundle does not contain the backend base URL')
if (!manifest.host_permissions?.some((h) => h.startsWith(baseUrl)))
  fail('backend origin missing from host_permissions')

const zip = `${out}.zip`
rmSync(zip, { force: true })
spawnSync('zip', ['-qr', zip, '.'], { cwd: out, stdio: 'inherit' })
console.log(`[build:test-join] OK
  extension id : ${id}
  version      : ${manifest.version_name}
  unpacked     : ${out}
  zip          : ${zip}
  backend      : ${baseUrl}
  externally_connectable: https://zabcore.com/*`)
