# Teams Lite (Checkpoint 1) — developer configuration & demo

Enrolled installs apply a centrally-managed `show_indicator` setting and report
their state back (content-free). The **Free (unenrolled) mode is network-silent**
— it makes zero network calls until the user explicitly enrolls.

This is an internal milestone (issue #78). Customer rollout and Store release are
out of scope; the milestone is accepted after the real-browser demonstration.

## Security model (do not violate)

- The extension uses the Supabase **anon (publishable) key** + its **per-install
  credential**. The anon key is public and safe to ship.
- **The service-role key NEVER appears in the extension or the portal.** It lives
  only in the edge-function server environment (`supabase secrets` / dashboard).
- The check-in body is **content-free**: only `install_id`, `credential`, and the
  optional `extension_version` / `self_test{passed,at}` / `applied_settings_revision`.
  No URLs, page content, clipboard, filenames, detected values, or counts.

## 1. Configure the build

```bash
cp .env.example .env.local
# edit .env.local:
#   VITE_TEAMS_BASE_URL=http://127.0.0.1:54321        # local supabase functions serve
#   VITE_TEAMS_ANON_KEY=<anon key from `supabase status`>
```

- An **unconfigured** build (neither var set) has no backend: enrollment reports
  "not set up" and nothing is called. Use this to reproduce the Free-mode build.
- `vite.config.ts` injects `VITE_TEAMS_BASE_URL`'s origin into `host_permissions`
  at build time. The committed `manifest.json` already grants the local supabase
  origins (`127.0.0.1:54321`, `localhost:54321`) for the dev demo.

## 2. Run the backend

In the `teams-lite-backend` project (migrations `0001–0003`, `enroll`/`checkin`
edge functions):

```bash
supabase start
supabase functions serve          # serves /functions/v1/enroll and /checkin
# seed an invite code per the backend README / migrations, then note it
```

The functions run with `verify_jwt=false` and authenticate the install from the
body; the extension sends the anon key as `apikey` + `Authorization: Bearer`.

## 3. Build & load the extension

```bash
npm run build
# chrome://extensions → Developer mode → Load unpacked → select ./dist
```

## 4. The demo loop (acceptance criteria 3–6)

1. **Enroll** — open the popup → *Team management* → paste the invite code →
   **Enroll**. Status becomes "Enrolled to `<org>`".
2. **Push a setting** — in the portal/DB, set Harbor's `show_indicator` and bump
   the settings revision. Within ~15 min (or immediately — the popup asks the SW
   to check in right after enrolling) the browser applies it: the on-page
   indicator shows/hides. The portal acknowledgment follows the **applied**
   revision (reported back on the next check-in).
3. **Isolation** — a second browser enrolled to a different org (Palmetto) is
   unaffected by Harbor's setting.
4. **Outage** — stop `supabase functions serve`. The last applied config is
   retained (never reset), and local warn-and-review protection keeps running.
5. **Revocation** — revoke the install server-side. The next check-in returns
   `{revoked:true}`: management stops, the managed overlay is removed, and the
   user's **previous** local preference is restored (not a blind default).
   Scanning continues throughout.

## Test tiers (report separately)

- **(a) Unit** — `npm test` (Vitest). Covers the contract, the pure state
  machine, the client HTTP mapping, the service persistence (apply / retain /
  revoke / snapshot-restore), the content-free payload, the self-test timestamp,
  and Free-mode silence. No network.
- **(b) Live Supabase HTTP** — `npm run teams:live-check` against a running
  `supabase functions serve` (needs a seeded code):

  ```bash
  TEAMS_BASE_URL=http://127.0.0.1:54321 \
  TEAMS_ANON_KEY=<anon> \
  TEAMS_CODE=<seeded code> \
  npm run teams:live-check
  ```

  Exercises the real enroll → checkin round-trip over HTTP.
- **(c) Real browser** — the loop in §4 with the unpacked build in Chrome.

## Free-mode silence is behavioral

Because this is one shared build, the bundle as a whole contains `fetch` (in the
enrollment client chunk). The guarantee is that the **unenrolled mode makes zero
network calls** — proven by `tests/teams-free-mode-silence.test.ts`, not by a
static "no fetch in the bundle" claim. The enrollment client is loaded only via a
dynamic `import()` from enrolled code paths, so `verify:no-network` sees its
`fetch` only in the isolated `teams-client-*.js` chunk (allowlisted with a
comment) and nowhere in the content-script / service-worker / popup chunks.
