# Gate C — coverage compatibility monitor

The **monitor** is the third consumer of the §D coverage definition
(`src/shared/coverage.ts`), alongside the extension and the self-test. Its
job is to catch the day a surface's DOM drifts and silently breaks an
adapter — the failure mode a static test can't see, because the extension
still builds and its unit tests still pass against fabricated DOM.

It loads the **packaged extension** (`dist/`) in Chromium and, for every
route the coverage definition describes, drives the real gesture and
checks the shipped extension does exactly what coverage _promises_:

| Coverage flag        | Monitor expectation                              |
| -------------------- | ------------------------------------------------ |
| route is `supported` | the extension **intervenes** and shows a warning |
| flag is `unsupported`| the extension **stays out of the way**           |
| flag is `unvalidated`| recorded, **never asserted** (unproven by design)|

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

## Dry-run (default) vs live

- **Dry-run** (`MONITOR_MODE=dry`, the default): each surface's real origin
  is served a **synthetic fixture** (`fixtures/<surface>.html`) via request
  interception. The fixtures faithfully reproduce each surface's live
  composer / send-button / file-input DOM (the shape the shipped adapters
  key on) plus `data-monitor` driving hooks. Because the committed URL is
  still the real `https://` origin, the packaged content script injects
  exactly as on the live site. **No network, no credentials.**
- **Live** (`MONITOR_MODE=live`): the interception is skipped and the real
  sites are loaded. This is how a true DOM drift is caught, but it needs an
  authenticated session per surface — see _Blockers_.

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

| Var                 | Default | Meaning                                                        |
| ------------------- | ------- | -------------------------------------------------------------- |
| `MONITOR_MODE`      | `dry`   | `dry` serves fixtures; `live` hits the real sites.             |
| `MONITOR_CHROMIUM`  | _unset_ | Explicit Chromium path (else Playwright resolves its managed one). |
| `MONITOR_NO_SANDBOX`| _unset_ | Set to `0` to keep the Chromium sandbox (default passes `--no-sandbox` for CI containers). |

## CI

`.github/workflows/coverage-monitor.yml` runs the dry-run monitor weekly
(and on PRs that touch the monitor, the adapters, or the coverage file). It
installs Chromium with `npx playwright install --with-deps chromium`, so it
does not depend on any pre-provisioned browser.

## Blockers / follow-ups

- **Live mode needs credentials.** Verifying against the _real_ sites
  requires a logged-in session per surface (a Playwright `storageState`),
  which can't live in this repo or in public CI. Live runs are gated behind
  `MONITOR_MODE=live` and are intended for a manually-triggered job with
  secrets, not the default heartbeat. Until that job exists, dry-run proves
  the adapter contracts against the fixtures, not against live DOM changes.
- **M365 Copilot is not independently probeable.** It shares
  `copilot.cloud.microsoft` with personal Copilot, so the monitor can only
  document it; validating its `unvalidated` paste needs a licensed-account
  live probe (§4).
- **Fixtures track the live DOM by hand.** They encode the selectors the
  adapters ship against as of this release; when a live run (or a manual
  DOM review) finds a surface has moved, update the matching fixture in the
  same change as the adapter.
