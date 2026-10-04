// Teams Lite (deployment m1) — self-hosted CRX packaging for managed installs
// (Chrome Enterprise Core / CBCM, no Store).
//
// Signs `dist/` with a FIXED private key so the extension ID is identical on
// every rebuild (force-install policies are keyed by that ID), and emits the
// files an admin needs, kept as TWO separate concerns:
//   • installation   — the signed .crx + update.xml (ExtensionInstallForcelist /
//                      Admin-console "add by ID + custom URL");
//   • configuration  — managed_schema.json (deploymentToken / autoEnroll, applied
//                      as the extension's own policy, separately).
//
// The private key NEVER lives in the repo (`*.pem` is git-ignored); pass its
// path in. Usage:
//
//   npm run build            # with the VITE_TEAMS_* config for the target backend
//   ALG_CRX_KEY=/secure/ai-leak-guard.pem \
//   ALG_UPDATE_BASE=https://updates.example.com/alg/ \
//   npm run pack:crx
//
// Output (release/selfhosted/): ai-leak-guard-<version>.crx, update.xml,
// managed_schema.json, extension-id.txt, POLICIES.md.

import { execFileSync } from 'node:child_process'
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const DIST = resolve('dist')
const OUT = resolve(process.env.ALG_CRX_OUT ?? 'release/selfhosted')

function fail(msg) {
  console.error(`[pack-crx] ${msg}`)
  process.exit(1)
}

const keyPath = process.env.ALG_CRX_KEY
if (!keyPath || !existsSync(keyPath)) fail('Set ALG_CRX_KEY to the FIXED signing key (.pem).')
const updateBase = process.env.ALG_UPDATE_BASE
if (!updateBase || !/^https?:\/\/.+\/$/.test(updateBase)) {
  fail('Set ALG_UPDATE_BASE to the hosting folder URL, with a trailing slash.')
}
if (!existsSync(join(DIST, 'manifest.json'))) fail('No dist/ — run `npm run build` first.')

/** Chrome's extension ID: SHA-256 of the DER public key, first 16 bytes, each
 *  hex nibble mapped 0-f → a-p. */
function extensionId(pem) {
  const der = createPublicKey(createPrivateKey(pem)).export({ type: 'spki', format: 'der' })
  const hex = createHash('sha256').update(der).digest('hex').slice(0, 32)
  return { id: [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join(''), der }
}

function chromeBin() {
  const candidates = [
    process.env.CHROME_BIN,
    '/opt/pw-browsers/chromium',
    'google-chrome',
    'chromium',
    'chromium-browser',
  ].filter(Boolean)
  for (const c of candidates) {
    try {
      execFileSync(c, ['--version'], { stdio: 'ignore' })
      return c
    } catch {
      // try next
    }
  }
  return fail('No Chrome/Chromium found; set CHROME_BIN.')
}

const pem = readFileSync(keyPath, 'utf8')
const { id, der } = extensionId(pem)
const manifest = JSON.parse(readFileSync(join(DIST, 'manifest.json'), 'utf8'))
const version = manifest.version
const crxName = `ai-leak-guard-${version}.crx`
const updateUrl = `${updateBase}update.xml`

// Stage a copy so the build output itself is untouched; point updates at the
// self-hosted update manifest.
const stage = mkdtempSync(join(tmpdir(), 'alg-crx-'))
const extDir = join(stage, 'ext')
cpSync(DIST, extDir, { recursive: true })
writeFileSync(
  join(extDir, 'manifest.json'),
  `${JSON.stringify({ ...manifest, update_url: updateUrl }, null, 2)}\n`,
)

execFileSync(
  chromeBin(),
  [
    '--no-sandbox',
    '--headless=new',
    `--pack-extension=${extDir}`,
    `--pack-extension-key=${resolve(keyPath)}`,
  ],
  { stdio: 'ignore', timeout: 120_000 },
)
const packed = join(stage, 'ext.crx')
if (!existsSync(packed)) fail('Chromium did not produce a .crx.')
const crx = readFileSync(packed)
if (crx.subarray(0, 4).toString('latin1') !== 'Cr24' || crx.readUInt32LE(4) !== 3) {
  fail('Output is not a CRX3 file.')
}
if (crx.indexOf(der) === -1) fail('The CRX is not signed with ALG_CRX_KEY.')

mkdirSync(OUT, { recursive: true })
writeFileSync(join(OUT, crxName), crx)
writeFileSync(join(OUT, 'extension-id.txt'), `${id}\n`)
cpSync(resolve('public/managed_schema.json'), join(OUT, 'managed_schema.json'))
writeFileSync(
  join(OUT, 'update.xml'),
  `<?xml version='1.0' encoding='UTF-8'?>
<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>
  <app appid='${id}'>
    <updatecheck codebase='${updateBase}${crxName}' version='${version}' />
  </app>
</gupdate>
`,
)
writeFileSync(
  join(OUT, 'POLICIES.md'),
  `# AI Leak Guard ${version} — self-hosted managed install

Extension ID (stable; fixed signing key): \`${id}\`
Update manifest URL: \`${updateUrl}\`

Host \`update.xml\` and \`${crxName}\` together at \`${updateBase}\`.
Off-store force-install requires a managed browser (Chrome Enterprise Core /
CBCM-enrolled, or domain-joined).

Apply these as TWO SEPARATE policies.

## 1. Installation policy (what to install)

- Admin console: Apps & extensions → Users & browsers → add **by ID**
  \`${id}\` from a **custom URL** \`${updateUrl}\` → Force install.
- Or registry (HKLM):
  \`Software\\Policies\\Google\\Chrome\\ExtensionInstallForcelist\`
  value \`1\` (REG_SZ) = \`${id};${updateUrl}\`

## 2. Configuration policy (deployment token) — schema: managed_schema.json

Only \`deploymentToken\` (string) and \`autoEnroll\` (boolean, default true).
There is no backend-URL setting; the destination is compiled into the build.

- Admin console: the extension's **Policy for extensions** (JSON):
  \`{"deploymentToken": {"Value": "<token>"}, "autoEnroll": {"Value": true}}\`
- Or registry (HKLM):
  \`Software\\Policies\\Google\\Chrome\\3rdparty\\extensions\\${id}\\policy\`
  - \`deploymentToken\` (REG_SZ) = \`<token>\`
  - \`autoEnroll\` (REG_DWORD) = \`1\` (or \`0\` to stage without enrolling)

Verify: chrome://policy (both policies, incl. the extension's) and
chrome://extensions (installed by policy, ID above).
`,
)
rmSync(stage, { recursive: true, force: true })

console.log(`[pack-crx] OK — ${crxName} (CRX3), extension ID ${id}`)
console.log(
  `[pack-crx] wrote ${OUT}/{${crxName}, update.xml, managed_schema.json, extension-id.txt, POLICIES.md}`,
)
