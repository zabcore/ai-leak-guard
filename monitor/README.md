# Gate C — coverage compatibility monitor

The **monitor** is the third consumer of the §D coverage definition
(`src/shared/coverage.ts`), alongside the extension and the self-test. Its
job is to catch the day a surface's DOM drifts and silently breaks an
adapter — the failure mode a static test can't see, because the extension
still builds and its unit tests still pass against fabricated DOM.

It loads the **packaged extension** (`dist/`) in Chromium and, for every
route the coverage definition describes, drives the real gesture and
checks the shipped extension does exactly what coverage _promises_:

| Coverage flag         | Monitor expectation                               |
| --------------------- | ------------------------------------------------- |
| route is `supported`  | the extension **intervenes** and shows a warning  |
| flag is `unsupported` | the extension **stays out of the way**            |
| flag is `unvalidated` | recorded, **never asserted** (unproven by design) |

The negative checks are the honesty teeth: if a change ever started
intercepting Copilot file uploads (`document: unsupported`) or Perplexity
sends (`send: unsupported`), the monitor fails and shows coverage and code
disagree.

## Enumeration is derived, never hard-coded

`coverage-plan.ts` reads `COVERAGE` and produces the probe matrix:

- **positive** probes come from each surface's `inputRoutes` (coverage
  lists a route only when its flag is `supported`);
- **negative** probes come from the `unsupported` flags;
- a surface whose origins are a strict subset of another's
  (M365 Copilot shares `copilot.cloud.microsoft` with personal Copilot) is
  **documented, not browser-probed** — it can't be isolated by origin, so
  it must not claim any route `supported`.

`coverage-plan.ts` is pure (no Playwright) and is pinned by a vitest suite
(`tests/monitor-coverage-plan.test.ts`) that runs in the main `npm test`
gate — so coverage and the monitor can't drift.

## Modes

- **Dry-run** (`MONITOR_MODE=dry`, the default): each surface's real origin
  is served a **synthetic fixture** (`fixtures/<surface>.html`) via request
  interception. The fixtures faithfully reproduce each surface's live
  composer / send-button / file-input DOM (the shape the shipped adapters
  key on) plus `data-monitor` driving hooks. Because the committed URL is
  still the real `https://` origin, the packaged content script injects
  exactly as on the live site. Catches **our** regressions (an adapter
  change breaking a route). **No network, no credentials.** It does NOT
  catch the site drifting under us — the fixture is frozen.
- **Live no-auth** (`MONITOR_MODE=live-noauth`): navigates the **real
  logged-out** origins (chatgpt.com, perplexity.ai, and the pre-hydration
  composer states — the exact states that leaked) and asserts the packaged
  extension still recognises the composer and mounts its modal host. Each
  surface is classified `PASS` / `PRODUCT_FAILURE` / `ENV_AUTH_FAILURE` /
  `UNCLASSIFIED` / `GAP` (see **Operating Gate C**). It is a **best-effort
  drift signal**: these sites bot-mitigate automated/datacenter clients, so a
  run from CI may legitimately return `UNCLASSIFIED`/`ENV_AUTH_FAILURE` with no
  product regression. **In CI this job is non-blocking** (`continue-on-error`)
  — it never red-gates the release. The dependable live proof is the guided
  self-test in a real browser (below); run `live-noauth` from a **real
  machine** to get a trustworthy drift signal.
- **Live (authenticated)** (`MONITOR_MODE=live`): reserved for once test
  accounts exist — same as live-noauth but with a `storageState` for
  logged-in surfaces (Gemini, Copilot). Not wired into CI yet.

## Running locally

```bash
npm run build            # produce dist/ (the packaged extension)
npm run monitor          # dry-run, all surfaces
```

The monitor launches Chromium with the extension loaded. In an environment
where Playwright's own managed browser isn't present but a Chromium is,
point at it explicitly:

```bash
MONITOR_CHROMIUM=/path/to/chromium npm run monitor
```

Useful env vars:

| Var                      | Default | Meaning                                                                                                     |
| ------------------------ | ------- | ----------------------------------------------------------------------------------------------------------- |
| `MONITOR_MODE`           | `dry`   | `dry` serves fixtures; `live-noauth` hits the real logged-out sites; `live` (future) adds a `storageState`. |
| `MONITOR_INDUCE_FAILURE` | _unset_ | Set to `1` to force exactly one probe to fail — proves the alert path end-to-end.                           |
| `MONITOR_CHROMIUM`       | _unset_ | Explicit Chromium path (else Playwright resolves its managed one).                                          |
| `MONITOR_NO_SANDBOX`     | _unset_ | Set to `0` to keep the Chromium sandbox (default passes `--no-sandbox` for CI containers).                  |

## CI

`.github/workflows/coverage-monitor.yml` runs **daily at 06:00 UTC** (and the
dry-run job also on PRs that touch the monitor, the adapters, or the coverage
file). It installs Chromium with `npx playwright install --with-deps chromium`,
so it does not depend on any pre-provisioned browser. Three jobs:

- **monitor-dry** — the fixture matrix; the **required gate** (runs on PRs and
  on the schedule). A dry-run failure fails the workflow.
- **monitor-live-noauth** — the real logged-out drift check; schedule/manual
  only, and **non-blocking** (`continue-on-error`). UNCLASSIFIED/ENV from
  bot-mitigation is expected and never fails the workflow.
- **heartbeat** — the dead-man's switch, tied to the **dry** job only, so
  alerting never depends on live-site reachability (see below).
- **release-gate** — dispatch-only; reads a **real-environment** store that CI
  live runs never write (see _Release evidence_).

## Operating Gate C

**Launch a manual run.** Actions → _Coverage Monitor (Gate C)_ → _Run
workflow_. Leave `induce_failure` off for a normal run. The two monitor jobs
run; open each job's log or download its `coverage-monitor-*-report` artifact.

**Reading a result.** In the **dry** job every non-PASS is a failure (the
required gate). In the **live-noauth** job every non-PASS is recorded and
surfaces in the log/artifact, but the job is non-blocking, so a bot-mitigated
`UNCLASSIFIED`/`ENV_AUTH_FAILURE` does not fail the workflow. Classify from the
test's message:

| Outcome              | Meaning                                                                                                                                                                                            | Action                                                                                                                                         |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **PASS**             | Composer found and the extension mounted its modal host.                                                                                                                                           | None. Counts as live-pass evidence (if fresh).                                                                                                 |
| **PRODUCT_FAILURE**  | Composer found but **no modal** — the surface drifted; a real silent leak.                                                                                                                         | Fix the adapter + add an `adapters.test.ts` regression, ship.                                                                                  |
| **ENV_AUTH_FAILURE** | No composer AND real environment evidence — a nav/network error, a bot-mitigation status (403/429), a `cf-mitigated` header, or a detected Cloudflare/Turnstile/CAPTCHA/interstitial/login marker. | Not a product bug. Expected from a datacenter/CI runner these sites bot-mitigate. Re-run from a real machine, or rely on the guided self-test. |
| **UNCLASSIFIED**     | Reached the page, no bot-mitigation signal, and still no composer. Unexpected. **Must be diagnosed** — never auto-filed as environment.                                                            | Investigate: is the selector stale (a silent drift dressed as "nothing there"), or is there a new block marker to teach `detectEnvMarker`?     |
| **GAP**              | A known state we cannot exercise live (Claude pre-hydration). A distinct non-green, non-product outcome.                                                                                           | None — it is covered offline by a dry regression fixture. Never counts as live evidence.                                                       |
| **NOT-RUN / stale**  | A scheduled run was skipped/delayed/errored, or a route's last PASS is > 36 h old.                                                                                                                 | The heartbeat did **not** ping → the dead-man's switch alerts. A stale route reads non-green in the status store.                              |

Only a **PASS within 36 h** counts as live-pass evidence. UNCLASSIFIED,
ENV_AUTH_FAILURE, PRODUCT_FAILURE, GAP, skipped, and stale never count.

**Per-route status store.** Each route (surface × state) keeps its own
`lastAttemptAt` / `lastResult` / `lastSuccessAt` / `consecutivePasses` in a
JSON store (`monitor/status/`), uploaded as an artifact. A run for one route
never refreshes another's — a green ChatGPT run cannot make a stale/blocked
Claude route read green. A route whose last PASS is older than **36 h** reads
stale. There are **two separate stores**, by design:

- **CI-scoped** (`ci-live-status.json`, cache `ci-live-status-*`) — written by
  the non-blocking `monitor-live-noauth` job. Best-effort drift signal only.
- **Real-environment** (`live-status.json`, cache `real-live-status-*`) — read
  by the release-gate; **never written by CI live runs**, so a bot-blocked CI
  run can neither satisfy nor fail the gate. Populated out-of-band from a real
  machine (below).

**Release evidence.** The release gate is: **(1)** the required CI **dry-run**
green, **plus (2)** the **guided self-test** `confirmed` on each live site, run
by a person in a real browser (a real composer + a real warning — the
dependable live proof). The optional `release-candidate` dispatch runs
`npm run verify:live-status` against the **real-environment** store and FAILS
unless every required route (`chatgpt:live-noauth`, `perplexity:live-noauth`)
is green — last result PASS, within 36 h, **≥ 2 consecutive passes**. It reads
only the real store, so CI live runs cannot satisfy or fail it; with no real
evidence recorded it fails closed.

**Running live-noauth from a real machine.** A datacenter/CI IP is bot-mitigated
by these sites, so automated live from CI cannot be relied on. From a real
residential machine you can get a trustworthy drift signal:

```bash
npm run build
MONITOR_MODE=live-noauth MONITOR_STATUS_PATH=monitor/status/live-status.json npm run monitor
npm run verify:live-status   # checks the real-environment store you just wrote
```

**Dead-man's switch.** The `heartbeat` job pings `secrets.HEALTHCHECK_URL`
**only** when the required **dry** job succeeded on the schedule (it is tied to
the dry path, not live reachability). GitHub sends no
email when a scheduled run simply never happens, so a missing ping — not a red
✗ — is what an outage looks like. Register a check at an external
healthcheck service (e.g. healthchecks.io), set its period to ~1 day with a
grace window, and store its ping URL as the `HEALTHCHECK_URL` repo secret. A
**missing ping** means the monitor did not complete a healthy run: treat it as a
red monitor, not "probably fine". If the secret is unset the job logs that it
skipped the ping (the switch is simply not armed yet).

**Prove the alert path (induced-failure check).** Run the workflow with
`induce_failure: true`. Exactly one probe fails on purpose (message: `INDUCED
FAILURE …`), the run goes red, and — on a scheduled run — the heartbeat does not
ping. This confirms a real failure would actually surface. Nothing else changes;
it is a no-op without the input.

**Prove staleness (absence never reads green).** Two independent guards:
(1) the dead-man's switch — skip/miss a scheduled run and no ping is sent, so
the external healthcheck alerts; (2) the 36 h per-route expiry — a route with no
fresh PASS reads stale in the store and fails the release-candidate gate, even
if an old PASS is on record. Both are unit-proven in
`tests/monitor-route-status.test.ts` (stale, missing, and non-PASS results are
never green) and observable by dispatching the release-candidate gate against a
store with no recent passes (it fails).

**Renewing credentials (future authenticated mode).** When logged-in surfaces
(Gemini, Copilot) are added, a Playwright `storageState` is captured from a
throwaway test account and stored as a repo secret, then consumed by
`MONITOR_MODE=live`. _Placeholder — no such secret exists yet._ When it does,
document its name here and its renewal cadence (sessions expire); a stale
storageState must surface as `ENV_AUTH_FAILURE`, never a false PASS.

## Blockers / follow-ups

- **Authenticated live needs credentials.** Logged-out drift is now covered by
  `MONITOR_MODE=live-noauth` (chatgpt.com, perplexity.ai, and the pre-hydration
  composers — the states that leaked). The **logged-in** surfaces (Gemini,
  Copilot) still need a per-surface Playwright `storageState`, which can't live
  in this repo or in public CI; that is the future `MONITOR_MODE=live` job,
  gated behind a secret. Until it exists, logged-in DOM drift is not monitored.
- **M365 Copilot is not independently probeable.** It shares
  `copilot.cloud.microsoft` with personal Copilot, so the monitor can only
  document it; validating its `unvalidated` paste needs a licensed-account
  live probe (§4).
- **Fixtures track the live DOM by hand.** They encode the selectors the
  adapters ship against as of this release; when a live run (or a manual
  DOM review) finds a surface has moved, update the matching fixture in the
  same change as the adapter.
