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
  extension still recognises the composer and mounts its modal host. This is
  the **drift detector**. **No credentials.** Each surface is classified
  `PASS` / `PRODUCT_FAILURE` / `ENV_AUTH_FAILURE` (see **Operating Gate C**);
  any non-PASS is a red run.
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

- **monitor-dry** — the fixture matrix; runs on PRs and on the schedule.
- **monitor-live-noauth** — the real logged-out drift check; schedule/manual
  only (a live hit on every PR would be wasteful and flaky).
- **heartbeat** — the dead-man's switch (see below).

## Operating Gate C

**Launch a manual run.** Actions → _Coverage Monitor (Gate C)_ → _Run
workflow_. Leave `induce_failure` off for a normal run. The two monitor jobs
run; open each job's log or download its `coverage-monitor-*-report` artifact.

**Reading a result.** Every non-PASS is a **red run** — the monitor never reads
green on a partial or skipped result. Classify from the failing test's message:

| Outcome              | Meaning                                                                          | Action                                                                                                                          |
| -------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **PASS**             | Composer found and the extension mounted its modal host.                         | None.                                                                                                                           |
| **PRODUCT_FAILURE**  | Composer found but **no modal** — the surface drifted; a real silent leak.       | Fix the adapter + add an `adapters.test.ts` regression, ship.                                                                   |
| **ENV_AUTH_FAILURE** | No composer appeared — page didn't load, CAPTCHA, interstitial, or a login wall. | Not a product bug. Re-run; if it persists, the site is blocking the runner (needs the authenticated mode / a different egress). |
| **NOT-RUN**          | A scheduled run was skipped/delayed, or a job errored before probing.            | The heartbeat did **not** ping → the dead-man's switch alerts. Investigate the workflow run.                                    |

**Dead-man's switch.** The `heartbeat` job pings `secrets.HEALTHCHECK_URL`
**only** when both monitor jobs ran and passed on the schedule. GitHub sends no
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
