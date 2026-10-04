// Teams Lite (#78) — live HTTP smoke check against `supabase functions serve`.
//
// This is the (b) "live Supabase HTTP" harness for acceptance criterion 2. It
// hits the SAME wire contract the extension uses (enroll → checkin), with the
// anon key as `apikey` + `Authorization: Bearer`. It is NOT part of `npm test`
// (it needs a running backend + a seeded invite code); run it by hand:
//
//   1) In teams-lite-backend: `supabase start` then `supabase functions serve`
//   2) Seed an invite code (see the backend README / migrations 0001–0003).
//   3) Run:
//        TEAMS_BASE_URL=http://127.0.0.1:54321 \
//        TEAMS_ANON_KEY=<anon key from `supabase status`> \
//        TEAMS_CODE=<seeded invite code> \
//        node scripts/teams-live-check.mjs
//
// It prints the enroll result, then a check-in with the returned credential, and
// exits non-zero on any failure — so it can gate the milestone.

const BASE = (process.env.TEAMS_BASE_URL ?? '').replace(/\/+$/, '')
const ANON = process.env.TEAMS_ANON_KEY ?? ''
const CODE = process.env.TEAMS_CODE ?? ''
const LABEL = process.env.TEAMS_LABEL ?? 'Live check · Node'

if (BASE === '' || ANON === '' || CODE === '') {
  console.error(
    'Missing env. Required: TEAMS_BASE_URL, TEAMS_ANON_KEY, TEAMS_CODE.\n' +
      'See the header of this file for the full run instructions.',
  )
  process.exit(2)
}

const headers = {
  'Content-Type': 'application/json',
  apikey: ANON,
  Authorization: `Bearer ${ANON}`,
}

function fail(msg) {
  console.error(`FAIL: ${msg}`)
  process.exit(1)
}

const enrollRes = await fetch(`${BASE}/functions/v1/enroll`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ code: CODE, label: LABEL }),
})
if (!enrollRes.ok) fail(`enroll returned HTTP ${enrollRes.status}`)
const enroll = await enrollRes.json()
for (const k of ['install_id', 'install_credential', 'org_id', 'org_name']) {
  if (typeof enroll[k] !== 'string') fail(`enroll response missing "${k}"`)
}
console.log(`enroll OK — org "${enroll.org_name}" (org_id ${enroll.org_id}), install ${enroll.install_id}`)

const checkinRes = await fetch(`${BASE}/functions/v1/checkin`, {
  method: 'POST',
  headers,
  body: JSON.stringify({
    install_id: enroll.install_id,
    credential: enroll.install_credential,
    extension_version: 'live-check',
  }),
})
if (!checkinRes.ok) fail(`checkin returned HTTP ${checkinRes.status}`)
const checkin = await checkinRes.json()
if (checkin.revoked === true) {
  console.log('checkin OK — response is {revoked:true}')
} else if (
  checkin.revoked === false &&
  typeof checkin.target_settings_revision === 'number' &&
  checkin.settings &&
  typeof checkin.settings.show_indicator === 'boolean'
) {
  console.log(
    `checkin OK — revision ${checkin.target_settings_revision}, show_indicator=${checkin.settings.show_indicator}`,
  )
} else {
  fail(`checkin response has an unexpected shape: ${JSON.stringify(checkin)}`)
}

console.log('\nLive HTTP check PASSED (enroll + checkin against the running backend).')
