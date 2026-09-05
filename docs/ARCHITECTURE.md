# AI Leak Guard — Architecture

## Core principle

Everything runs locally in the user's browser. No backend, no database, no telemetry, no user text ever leaves the device. The extension makes no outbound network requests — detection rules ship bundled and update only through the Chrome Web Store.

## Tech stack

- **Language:** TypeScript
- **Bundler:** Vite (with `vite-plugin-web-extension` or similar)
- **Test runner:** Vitest
- **Linter:** ESLint with TypeScript plugin
- **Formatter:** Prettier
- **Manifest:** Chrome Manifest V3
- **UI:** Vanilla TypeScript + HTML for popup, Shadow DOM for in-page toast (no React in V1 — bundle size matters for extensions)

## Project structure

```
ai-leak-guard/
├── manifest.json                 # Chrome MV3 manifest
├── package.json
├── tsconfig.json
├── vite.config.ts
├── .eslintrc.json
├── .prettierrc
├── src/
│   ├── detector/
│   │   ├── engine.ts             # Pure detection function, no DOM/Chrome APIs
│   │   ├── rules.ts              # Bundled default rules
│   │   ├── validators.ts         # Luhn, entropy, SSN exclusions
│   │   └── types.ts              # TypeScript types for Finding, Rule
│   ├── content/
│   │   ├── index.ts              # Content script entry, paste interception
│   │   ├── adapters/
│   │   │   ├── base.ts           # Adapter interface
│   │   │   ├── chatgpt.ts        # ChatGPT-specific input insertion
│   │   │   ├── claude.ts         # Claude.ai-specific
│   │   │   ├── gemini.ts         # Gemini-specific
│   │   │   ├── perplexity.ts     # Perplexity-specific
│   │   │   └── copilot.ts        # Microsoft Copilot-specific
│   │   ├── masker.ts             # Apply masks to text given findings
│   │   ├── preview-flow.ts       # Pure logic for the preview-before-send modal
│   │   ├── preview-modal.ts      # Shadow DOM modal (V1.1 PR 4)
│   │   ├── toast.ts              # Shadow DOM confirmation toast (no Undo in V1.1)
│   │   ├── document-flag.ts      # V1.2 A1 feature-flag guard (default ON as of M6 v1.2.0)
│   │   ├── document-flow.ts      # V1.2 A1 hold state machine
│   │   ├── document-decision.ts  # V1.2 A4 shared clean/sensitive/unable helper
│   │   ├── document-modal.ts     # V1.2 A4 warning modal (scanning/sensitive/unable)
│   │   ├── document-nudge.ts     # V1.2 A1 re-attach nudge (Shadow DOM one-liner)
│   │   ├── file-extraction.ts    # V1.2 A1 File[] extraction from change/drop/paste
│   │   ├── file-inspector.ts     # V1.2 A1 inspector STUB (no parsing, no findings)
│   │   ├── upload-release.ts     # V1.2 A1 DataTransfer replay + pass-through-once
│   │   ├── fsa-isolated.ts       # V1.2 A1.1 isolated-world FSA hold-request handler
│   │   └── main-world/
│   │       ├── fsa-hook.ts       # V1.2 A1.1 MAIN-world showOpenFilePicker wrapper
│   │       └── fsa-messages.ts   # V1.2 A1.1 cross-world message shapes + validators
│   ├── background/
│   │   └── service-worker.ts     # Service worker entry (bundled rules only)
│   ├── popup/
│   │   ├── index.html
│   │   ├── popup.ts              # Counter display, on/off toggle
│   │   └── popup.css
│   └── shared/
│       ├── storage.ts            # Thin wrapper over chrome.storage.local
│       └── counter.ts            # Local leak counter logic
├── tests/
│   ├── detector.test.ts          # Unit tests for detection engine
│   ├── validators.test.ts        # Luhn, entropy, SSN edge cases
│   └── fixtures/
│       └── sample-payloads.ts    # Fake SSNs, fake keys, fake credit cards
├── docs/                         # (this folder)
└── .github/
    └── workflows/                # CI/CD
```

## Detection engine contract

The detector is a **pure function**:

```typescript
function detect(text: string, rules: Rule[]): Finding[]
```

- No DOM access
- No Chrome API access
- No network access
- Testable in Node with Vitest
- Deterministic: same input always produces same output

This separation is critical. The detector must be unit-testable in CI without a browser.

## Detection rules (V1)

Each rule has:

- `id`: stable identifier
- `label`: human-readable name shown in toast
- `pattern`: RegExp
- `validate`: optional function for post-pattern checks (e.g., Luhn for credit cards)
- `severity`: critical | high | medium

V1 rules:

- `aws_access_key`: `\bAKIA[0-9A-Z]{16}\b`
- `github_pat`: `\b(ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{36,}\b`
- `openai_key`: `\bsk-[A-Za-z0-9]{20,}\b`
- `anthropic_key`: `\bsk-ant-[A-Za-z0-9_-]{20,}\b`
- `stripe_key`: `\b(sk|pk|rk)_(live|test)_[A-Za-z0-9]{20,}\b`
- `google_api_key`: `\bAIza[0-9A-Za-z_-]{35}\b`
- `jwt`: 3-part dot-separated base64 structure
- `private_key_block`: `-----BEGIN (RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----` through `-----END`
- `ssn`: `\b(?!000|666|9\d{2})\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b`
- `credit_card`: 13–19 digit groups + Luhn validation
- `generic_secret`: `(password|secret|token|api[_-]?key)\s*[:=]\s*["']?[A-Za-z0-9+/=_-]{16,}` + entropy > 3.5

## Detection taxonomy and combination scoring (V1.1)

V1.1 layers a small taxonomy on top of the rule table so future detectors
(clinical context, patient identifiers, provider IDs) can be reasoned about
without hard-coding per-rule masking policy in the content script.

**Categories** (`DetectorCategory`):

- `IDENTITY` — patient-side identity signals
- `HEALTHCARE_PATIENT_ID` — MRNs and other patient identifiers
- `GOVERNMENT_FINANCIAL` — SSN, credit card, etc.
- `PROVIDER_ID` — provider identifiers (NPI, DEA)
- `CLINICAL_CONTEXT` — ICD/CPT codes, medications, procedures (context, not
  patient PHI on its own)
- `DEVELOPER_CREDENTIAL` — API keys, JWTs, private keys, generic secrets

**Sensitivity levels** (`SensitivityLevel`): `CRITICAL`, `HIGH`, `MEDIUM`, `LOW`.
V1.1 uses only `CRITICAL`, `HIGH`, and `LOW`; `MEDIUM` is reserved for
per-item preview control in a later release.

Each rule declares a `category` and a `baseSensitivity`. After collecting
findings, the engine runs `applyCombinationScoring(findings)` to compute each
finding's `effectiveSensitivity`:

- **Rule A** — findings whose category is not `CLINICAL_CONTEXT` keep their
  `baseSensitivity`.
- **Rule B** — `CLINICAL_CONTEXT` findings are `LOW` in V1.1 regardless of what
  else is present (identifiers get masked; context stays visible).
- **Rule C** — `LOW` is never promoted in V1.1 (V1.2 may escalate identifier
  sensitivity when clinical context is present, but not the context finding
  itself).

The content script masks a finding when `effectiveSensitivity` is `CRITICAL`
or `HIGH` (or unset — bare-Rule inputs preserve pre-V1.1 behavior). For the
V1 rule set every finding lands at `CRITICAL` or `HIGH`, so V1.0 masking
behavior is unchanged; the scoring layer is installed ahead of the healthcare
detectors that ship in a subsequent PR.

`detect()` returns `Finding[]` for backward compatibility; new callers can use
`detectDetailed()` which returns `{ findings, hasCriticalOrHigh }`.

## Healthcare detectors (V1.1 PR 2)

PR 2 adds 15 detectors on top of the V1 developer-credential set, populating
the taxonomy categories from PR 1:

- **IDENTITY** — `date_of_birth` (contextual), `phone` (bare + `isPlausiblePhone`
  validator), `email` (bare).
- **HEALTHCARE_PATIENT_ID** — `mrn`, `member_id`, `claim_number`, `rx_number`,
  `patient_id` (all contextual).
- **GOVERNMENT_FINANCIAL** — `account_number`, `license_number` (contextual;
  join the V1 `ssn` and `credit_card` in this category).
- **PROVIDER_ID** — `npi` (bare + `isValidNpi` checksum, "80840" prefix +
  Luhn), `dea` (bare + `isValidDea` checksum, `(d1+d3+d5)+2*(d2+d4+d6)` mod 10
  == d7 with a registrant-type letter set).
- **CLINICAL_CONTEXT** — `icd10` (bare regex, letter + 2 digits + optional
  subcode), `cpt` (contextual), `medication` (dictionary — see below). All
  three set `isContextSignal: true`, land at `LOW` after
  `applyCombinationScoring`, and are NOT masked.

### Contextual detectors and the `contextualRule` helper

Contextual detectors fire ONLY when a label + separator + value appear
together in the text — a bare identifier value (e.g. `12345678` with no
"MRN" nearby) does NOT match. The shared `contextualRule` factory in
`src/detector/rules.ts` builds all label-anchored detectors from the same
template:

```
\b(?:LABEL)\s*[:#]?\s*(VALUE)\b   with the `gi` flag
```

The value pattern for identifier-style detectors additionally requires at
least one digit inside the value (via a lookahead) so a match like
`Member ID John` cannot capture `John` as an identifier. The engine's
`validate` callback receives the whole `match[0]`; when `validateValue` is
supplied to `contextualRule`, we re-extract the capture group and pass it
through — the same pattern the V1 `generic_secret` detector already uses.

Because the engine uses `match[0]` as the finding's `value`, masking replaces
the WHOLE labeled span with the mask token — the output reads
`"The patient's [MRN]"` rather than `"The patient's MRN: [MRN]"`.

### Medication dictionary

`src/detector/data/medications.ts` ships a curated list of ~320 common
generic + brand medication names (single-word entries, lower-case, matched
case-insensitively on word boundaries). It is intentionally a plain data file
so it can be reviewed and extended by appending to the exported array
without touching engine code. The source is documented at the top of that
file (publicly available top-prescribed U.S. medication lists; FDA Orange
Book brand equivalents). Multi-word brand names are deferred to a later
pass.

### Explicit mask tokens

V1.1 rules can declare an explicit `maskToken` (e.g. `"[MRN]"`). The masker
uses it if present and falls back to a label-derived form
(`"US Social Security Number"` → `"[US_SOCIAL_SECURITY_NUMBER]"`) otherwise.
V1 rules leave `maskToken` unset, preserving their existing placeholders
byte-for-byte.

### Patient names + street addresses (V1.1 PR 3)

Two more `IDENTITY` / `HIGH` detectors, both anchored — never free-prose:

**`patient_name`** — fires only on `<patient-side label><separator><name>`.
Labels: `Patient`, `Patient Name`, `Pt`, `Member`, `Insured`,
`Subscriber`, `Guarantor`. The bare `Name` label from the original spec is
intentionally omitted: `Provider Name: Alice Wong` would otherwise match
`Name: Alice Wong` and silently mask a provider name; `Name:` alone is
also weak signal (`Product Name:`, `File Name:`, `User Name:` are common
non-medical forms). Provider labels (`Provider`, `Physician`, `Dr`,
`Referring`) are excluded by this detector's scope — this is a
detector-shape decision, not a universal privacy determination. Under
HIPAA's Safe Harbor de-identification method, provider names are not
required to be removed, but other privacy contexts (e.g. 42 CFR Part 2
for SUD records, state-specific confidentiality statutes, or a product's
own policy) may still call for masking them. The `NPI` and `DEA` rules
detect provider identifiers — not provider names. Whether provider names
should be masked at all is a separate policy call left to a future
detector. Separator is REQUIRED (one of `:`, `-`, `–`, `=`) — a bare-label
prefix like "the patient Sarah Khan reported…" would otherwise trigger.
Value is 2–4 capitalized tokens (`First Last`, `First Middle Last`,
`First M. Last`) OR `Last, First [Middle]`. Tokens allow apostrophes
(`O'Brien`) and hyphens (`Smith-Jones`). Mask token: `[PATIENT_NAME]`.

**`street_address`** — fires on EITHER a structural anchor (leading house
number + capitalized street-name words + street-type suffix from a fixed
set of ~18 suffixes + optional unit indicator) OR a label anchor (`Address`
/ `Addr` / `Home Address` + required separator + rest of line). The
leading house number is the discriminator for the structural form — it is
what separates a real address from a street name mentioned in prose
("We met on Main Street" → no fire). Mask token: `[ADDRESS]`.

Both detectors are compiled with the `g` flag only (not `gi`) so
case-sensitive `[A-Z]` classes actually discriminate — under `gi`, `[A-Z]`
also matches `[a-z]` and the "must start with a capital" property that
distinguishes names from prose evaporates. Case-insensitivity for the
labels themselves is expressed inline: a small `ci()` helper expands each
letter of a label alternative to a `[Xx]` character class, so `Patient`,
`patient`, `PATIENT`, and any mixed-case variant all match.

`patient_name` does NOT go through `contextualRule` — its value regex needs
that case-sensitive discipline, and the helper's `gi` compilation is a
poor fit. `contextualRule` remains the right tool for the identifier
detectors (MRN, member ID, claim, patient ID, account, license, CPT, DOB)
where labels and values are both alphanumeric identifiers.

## Site adapter contract

Each AI site has different input editors (contenteditable, ProseMirror, Lexical, etc.). The adapter interface:

```typescript
interface SiteAdapter {
  domain: string[] // ["chatgpt.com", "chat.openai.com"]
  isInputElement(el: Element): boolean
  insertText(el: Element, text: string): boolean // returns success
  replaceContents(el: Element, text: string): boolean
}
```

Default fallback uses `document.execCommand('insertText')` which still works on Chrome for contenteditable inputs even though it's deprecated. Site-specific adapters override when needed.

## Paste interception ordering (why we listen on `window` at `document_start`)

Content-script `run_at` is `document_start` and the paste listener is
attached to `window` in the capture phase. Both are load-bearing on
ChatGPT-style editors:

- **`window` in capture** — the DOM event flow for capture is
  `window → document → html → … → target`. A capture-phase listener on
  `window` runs before any capture-phase listener on `document` (or any
  inner element) regardless of registration time — different
  `EventTarget`s, different lists. Registration order only settles ties
  _within the same target_. So a site handler attached in capture on
  `document` (which is what ChatGPT's app does) always fires after our
  `window` capture listener, and our `stopImmediatePropagation` prevents
  it from ever running.
- **`document_start`** — the only remaining hole is a site that ALSO
  attaches its paste listener on `window` in the capture phase. There
  the two live on the same `EventTarget`, so registration order decides
  which one fires first. Content scripts default to `document_idle`,
  which runs after the page's own scripts have already registered.
  `document_start` runs the extension's code before the page's scripts,
  so we register on `window` first and win that tie too.

Result: with both together plus `stopImmediatePropagation` we cover
both cases (site attaches on `document` — window-vs-document capture
ordering wins; site attaches on `window` — registration-order wins),
and no known site can slip a paste behind our modal.

The combination is defensive: either mechanism alone was insufficient on
ChatGPT — with the two together plus `stopImmediatePropagation`, the
site never sees the paste event and cannot double-insert the original
text behind our modal.

## Paste interception flow (V1.1 PR 4 — preview-before-send)

**Behavior change vs V1.0:** V1.0 masked silently on paste and showed a
confirmation toast. V1.1 previews first — the user sees exactly what would
be masked and chooses `Paste protected version`, `Paste as-is`, or cancel.
Detection is unchanged; only the interaction is new.

1. Content script attaches a **capture-phase** `paste` event listener on
   `document`.
2. When fired, extract plaintext via `readPastedText` (see
   `src/content/clipboard-text.ts`): try `clipboardData.getData('text/plain')`
   first, and if that slot is empty/whitespace, fall back to
   `text/html` stripped through an inert `DOMParser` (no script
   execution, no resource fetches) so pastes from rich-text web
   apps — web EMRs, Google Docs, Notion, Microsoft 365 web —
   still get inspected. If the clipboard carried non-`Files` bytes
   we could not decode into plaintext, log a metadata-only
   `unable-to-inspect` event so the miss appears in the activity
   log rather than failing silently.
3. If a preview modal is already on screen (from an earlier paste), call
   `preventDefault` + `stopPropagation` and drop this event — the spec is
   "additional paste events are ignored until the current modal resolves."
4. Call `detectDetailed(text)`. If `hasCriticalOrHigh === false` (clean text
   or context-only LOW findings), do nothing — let the native paste
   proceed. This is the zero-friction path.
5. If `hasCriticalOrHigh === true`:
   - `e.preventDefault()` + `e.stopPropagation()`.
   - Build a `PreviewSummary` via `preview-flow.ts` — it filters findings
     through `isMaskable` (the same predicate that decides masking), groups
     by human label with counts, and computes `mask(text, maskable).text`
     as the redacted preview.
   - Open the preview modal (`preview-modal.ts`) — Shadow DOM, closed root,
     `role="dialog"`, `aria-modal="true"`, focus trapped, Escape cancels,
     Enter activates the primary action.
   - Resolve on user action:
     - `Paste protected version` → insert the masked text through the site
       adapter, increment counters, show a confirmation toast
       (`N sensitive items masked (…)`, close (×) only, no Undo).
     - `Paste as-is` → insert the original text unchanged; no toast, no
       counter.
     - Cancel (Escape / close / backdrop) → insert nothing; return focus
       to the paste target as if the paste never happened.

**No Undo in V1.1.** V1.0 shipped an Undo button on the confirmation
toast. That mechanism was reliable on plain `<textarea>` inputs but did
not work on the ProseMirror-based editors used by ChatGPT and Claude
(the editor transforms pasted placeholder brackets so the
`textContent`-based replacement can't find them). The preview-before-send
modal already gives the user a deliberate pre-insertion decision — a
subsequent Undo would be a second control that mostly fails and gives
false confidence rather than adding safety. V1.1 therefore removes Undo
entirely from the paste flow, along with the counter's `decrement`
path that only Undo used. Reintroducing Undo (or a broader
per-paste history / analytics view) is deferred to V1.2, if it lands
at all.

**Single source of truth for "will be masked."** The modal never re-derives
sensitivity. `preview-flow.ts` calls the engine's `isMaskable(finding)`
helper — the same one the actual masking path uses — so the "what will be
masked" list, the redacted preview, and the inserted text can never drift.
LOW / clinical-context findings are excluded by `isMaskable` and are
therefore never surfaced anywhere in the modal.

**Split of concerns:** `preview-flow.ts` is pure logic (decision + summary
builder, no DOM) so it can be exercised by fast unit tests.
`preview-modal.ts` is the Shadow DOM component and returns a promise that
resolves to the outcome, keeping the paste-flow wiring simple and
side-effect-free.

## Storage schema

`chrome.storage.local`:

```typescript
{
  counters: {
    total: number,
    byType: Record<string, number>,    // ruleId -> count
    byDay: Record<string, number>,     // YYYY-MM-DD -> count
  },
  prefs: {
    enabled: boolean,
  },
  // V1.2 A5 (#40): metadata-only per-decision event log.
  // Bounded ring buffer, oldest-first — see MAX_EVENTS (200) in
  // src/shared/event-log-schema.ts. Field shape is fixed and enforced by
  // a persisted-payload test that asserts NO `value` / `text` /
  // `content` / `name` / `filename` key EVER lands in storage.
  events: Array<{
    ts: number,
    site: string,                     // 'chatgpt'|'claude'|'gemini'|'perplexity'
    eventType: 'paste' | 'document',
    action:
      | 'protected' | 'as-is'                 // paste only
      | 'cancelled'                           // both paste and document
      | 'uploaded-anyway' | 'auto-cleared'
      | 'unable-to-inspect',                  // document only
    categories: DetectorCategory[],   // distinct maskable categories (empty when none/unable)
    count: number,                    // maskable items detected (0 for clean/unable)
    hadCriticalOrHigh: boolean,
  }>,
}
```

### Event log — moat rule + wiring

The log stores **metadata only, never content.** No matched value,
masked/reconstructed text, extracted document text, or filename
ever lands in `events[]`. This keeps the "ZabCore never receives
patient content" claim honest and is the exact record shape a
future paid-tier dashboard would aggregate, so nothing changes
downstream when we ship that — the on-device schema is already
free of content.

`appendEvent` is documented **never-throws**: projects the event
through the allowlist (`projectAlgEvent` in
`src/shared/event-log-schema.ts` — the single moat-rule choke
point that drops any content-shaped extras), then posts a
`chrome.runtime.sendMessage({type: 'alg-event-append', event})`
to the service worker. The service worker owns the ONLY writer
of the `events` key — content-script `writeChain` serialisation
would race across tabs (each open ChatGPT / Claude tab has its
own module instance, so two tabs appending at the same time
would each `get` the same array and `set` back over each other).
The service worker is a single Chrome-wide instance across all
tabs and frames, so funnelling writes through it makes the
read-modify-write serialisation actually mean something. See
`src/background/service-worker.ts`.

A storage failure, an unreachable service worker, or a projection
rejection all log a warning; the paste / document flow never
awaits or gates on the append (the user's action MUST land
regardless of whether we could record a metadata note about it).
The projection is applied at BOTH boundaries — content-script
side (before sendMessage) and service-worker side (before write)
— so a schema regression at either end is caught.

**Wiring points** (all pass the already-computed detection /
aggregate result — never re-scan, never receive raw content):

- **Paste** (`src/content/index.ts` — `logPasteEvent`):
  - `protected` — user took the masked version
  - `as-is` — user pasted the original despite detection
  - `cancelled` — user cancelled the preview modal
- **Document** (`src/content/document-decision.ts`):
  - `auto-cleared` — clean file, auto-proceeded without a modal
  - `uploaded-anyway` — released despite the sensitive warning
  - `cancelled` — cancelled the modal in any state
  - `unable-to-inspect` — released the uninspectable file

The document helper takes `siteId` via `opts.siteId` so the popup's
per-site breakdown is honest across both hold paths (change / drop
/ paste through `document-flow.ts` and the FSA picker through
`fsa-isolated.ts`, both of which forward `adapter.id`).

### Popup + activity page + export (A5.1)

The extension surfaces the event log in TWO places, both fed from
`chrome.storage.local` via `getEvents()`:

- **Popup** (`src/popup/index.html` + `popup.ts`) — a compact
  summary the user sees on the browser-action click. The
  headline number is `counters.total` and counts INDIVIDUAL
  sensitive items masked on the paste path (one match = one
  item). The Activity tiles are derived from `summariseEvents()`
  and count EVENTS (one paste or one file upload = one event).
  The two units are labelled and styled distinctly (headline is
  a 48px number with "Sensitive items masked"; each tile is a
  smaller number with an "events" trailing unit) so a glance
  never blurs "items" into "events". A "View all activity →"
  button calls `chrome.runtime.openOptionsPage()`.

- **Activity page** (`src/popup/activity.html` + `activity.ts`,
  registered as the extension's `options_ui` with
  `open_in_tab: true`) — renders the full ring buffer
  newest-first with per-row timestamp, site, event type, action
  badge, friendly category chips (same copy as the A4 modal),
  and item count. Empty state on a fresh install; a "showing
  the most recent 200" caption when the buffer is at
  `MAX_EVENTS`. Every cell writes via `textContent` from
  AlgEvent schema fields — no innerHTML, no template with
  attribute injection.

- **Local export** (`src/popup/export.ts`) — CSV + JSON
  serialisers that project each event onto the seven-field
  allowlist (`EXPORT_FIELDS`), convert `ts` to ISO 8601, and
  hand the resulting text to a `Blob` + `URL.createObjectURL`
  - `<a download>` click. `URL.revokeObjectURL` on the next
    microtask. NO `fetch`, NO network, NO new permission —
    `chrome.downloads` is intentionally NOT requested. The
    manifest-permissions test enforces this. Filename shape:
    `ai-leak-guard-activity-YYYYMMDD.{csv,json}`.

The moat rule holds through the export path: a no-content guard
test enumerates the forbidden field set
(`value` / `text` / `content` / `name` / `filename` / `body` /
`raw`) and asserts NO row in either serialiser carries one, even
when a hostile input event stapled them on. The activity page
render is tested with a hostile-value fixture — a known SSN
literal and a filename literal MUST be absent from the rendered
DOM.

## Rules update mechanism

- Detection rules are bundled with the extension (see `src/detector/rules.ts`).
- Rule updates are delivered only through Chrome Web Store extension updates.
- The extension does not fetch or cache remote rules at runtime, and makes no outbound network requests of any kind. A future remote-rules pipeline is out of V1.1 scope.

## Permissions (Manifest V3)

Minimum required:

- `storage` — for the local counter and the on/off preference

Pasted text is read from the paste event's own `clipboardData`, which does not require a `clipboardRead` permission. There is no `chrome.scripting` or `chrome.alarms` usage; content scripts are declared statically in `manifest.json`.

`host_permissions`:

- `https://chatgpt.com/*`
- `https://chat.openai.com/*`
- `https://claude.ai/*`
- `https://gemini.google.com/*`
- `https://www.perplexity.ai/*`
- `https://copilot.microsoft.com/*`

No broad `<all_urls>` permission. Tight host list reduces Chrome Web Store review friction.

## Security considerations

- Never use `eval()` or `new Function()` on remote rule patterns
- Validate every remote regex against a fuzz string with a timeout before compiling
- Toast UI uses Shadow DOM with `mode: 'closed'` so target sites can't restyle or read it
- All extension messaging stays within the extension — no `window.postMessage` to page context
- No external scripts loaded at runtime (CSP-compliant by default)

## Performance budget

- Detection on a typical paste (<5KB): under 5ms
- Detection on a large paste (50KB): under 50ms (acceptable for paste interactions)
- Extension bundle size: under 200KB total
- Memory footprint: under 5MB resident

## Document-protection foundation (V1.2 A1 — flagged OFF)

V1.2 introduces file-upload interception in three PRs (A1 plumbing, A2
inspector, A3 UX). A1 lands the plumbing only, behind a hard-coded
feature flag that defaults **OFF**. Flag OFF = byte-for-byte V1.1.1
behavior; no listeners register that alter native file-input, drop, or
paste-with-files handling.

**Product model (locked at A0 close):** document protection **warns,
never blocks**. Two outcomes only —

- `Upload anyway` (primary) → release the ORIGINAL file to the host.
  There is NO "clean copy" of a document in V1.2; the file goes up
  as the user selected it.
- `Cancel` → discard the file client-side; nothing uploads. For a
  change event the origin `<input type="file">` is reset via
  `input.value = ''` so the site sees no selection at all. For
  drop / paste there is nothing to reset — our capture-phase
  `preventDefault` + `stopImmediatePropagation` already blocked the
  host handler from firing.

**Feature flag:** `src/content/document-flag.ts` exposes
`isDocumentProtectionEnabled()`. Reads from
`globalThis.__AI_LEAK_GUARD_DOC_FLAG__` if set (tests + future popup
plumbing use this), else falls back to a compile-time constant. The
flag is re-read on every call so a mid-session flip is honored by
the next event.

**M6 GA (v1.2.0):** the compile-time default flipped to `true`.
The flag itself is preserved (not deleted) — a future site
regression can still be disabled at runtime via the override
without a new release, and `tests/document-flag.test.ts` still
pins both the ON default AND the runtime-kill-switch behavior.

**Sites in scope:** ChatGPT, Claude, Gemini, Perplexity. Copilot is
**deferred** for this release; the paste-flow adapter still handles
Copilot for text paste, but no file-interception listeners fire there.
The scope allowlist lives in `src/content/index.ts` next to the flag
check.

**Interception seams (all window-capture at `document_start`):**

1. **change** on `<input type="file">` — extract via
   `extractFilesFromChange` (`src/content/file-extraction.ts`),
   which is the only path with a discoverable origin input for the
   DataTransfer replay.
2. **drop** on the composer — extract via `extractFilesFromDrop`.
   No origin input; release path falls back to the pass-through-once
   fallback (see below).
3. **paste** with `clipboardData.files` — extend the existing V1.1
   paste handler to check for files BEFORE the text/plain read.
   Pasted images pass through untouched in V1.1.1; this branch
   catches them.

Same event ordering rationale as V1.1 paste — see "Paste interception
ordering" above. When the flag is OFF, `documentFlowActive()` returns
false and every one of these branches is a strict no-op.

**Hold state machine (`src/content/document-flow.ts`, A4-final):**

```text
extract → inspect → resolveDocumentDecision
    ├─ 'upload-anyway' → releaseFiles(state)
    └─ 'cancel'        → clearInput(origin) if change; else drop
```

`resolveDocumentDecision` branches on the A3 `AggregateScanResult`
— clean auto-releases, sensitive / unable open the matching modal
view, and the cancellable "Checking…" state paints between them
when extraction is slow. See the A4 section further below for the
full state machine.

The inspector at A1 is a **stub** (`src/content/file-inspector.ts`)
that returns `findings: []` for any input and never reads file
bytes — the state machine still calls it so A2 can drop in the real
inspector without touching the orchestrator.

**Release strategies (`src/content/upload-release.ts`):**

1. **DataTransfer replay on the origin input** (preferred). For a
   change event, build a fresh `DataTransfer`, assign
   `input.files = dt.files`, dispatch a synthetic bubbling `change`.
   Arms the pass-through-once guard BEFORE the assignment so the
   replayed change is not re-intercepted (some frameworks
   synchronously fire on `input.files = ...`).
   - **Confirmed by A0 matrix as feasible on:** ChatGPT, Claude,
     Perplexity — all use a light-DOM `<input type="file">`.
   - **Likely to fail on:** Gemini — if the file input lives inside
     the `<rich-textarea>` closed shadow root, `input.files`
     assignment is unreachable from outside the root; the release
     falls through to strategy 2.
2. **Pass-through-once fallback.** When strategy 1 fails, or the
   source event was a drop / paste (no origin input), the release
   arms a one-shot guard keyed to the event kind and reports
   `needs-user-reattach`. The next matching event fires natively;
   the arming clears on that event OR after a 30-second TTL, so a
   stuck flag cannot leak a future legitimate paste. A1 keeps the
   post-release UI minimal (a follow-up nudge is A3 material).

**Files-defensively invariant.** No module in the A1 plumbing reads
file bytes. `file-inspector.ts` holds `{ name, size, type, file }`
references only. The release path passes the `File` object through
to a `DataTransfer` untouched. When the A2 inspector arrives it will
add reads through a controlled seam; the plumbing shape stays fixed.

**What A1 explicitly does NOT ship:**

- No parser (PDF.js, DOCX, plaintext, image OCR).
- No detector-engine calls for file content.
- No network requests originated by the extension.
- No final UX — the placeholder modal is intentionally minimal.
- No popup control for the flag — the flag is compile-time only in
  A1. The popup toggle lands with A3.

## FSA picker interception (V1.2 A1.1 — flagged OFF)

A1's `change` / `drop` / `paste` seams cover the DOM event surface,
but they miss the **File System Access** picker
(`window.showOpenFilePicker()`) — the API ChatGPT's `+` → "Add photos
& files" invokes. `showOpenFilePicker` is a plain function call on
the page's own `window`, so no DOM event fires and the isolated
content script cannot see it.

A1.1 adds a **MAIN-world content script** that wraps the picker on
the page's own window. When the wrapper is called it awaits the
native picker (which pops the OS dialog just like it always has),
extracts file metadata, hands the decision to the isolated world
through `window.postMessage`, and either returns the ORIGINAL
handles (upload-anyway) or throws the exact `AbortError` the native
picker throws on cancel. Same flag, same modal, same silent-release
model as A1: **document protection warns, never blocks**.

**The two-script layout:**

- `manifest.json` adds a second `content_scripts` entry with
  `"world": "MAIN"` and `"run_at": "document_start"` running
  `src/content/main-world/fsa-hook.ts`. `document_start` is
  load-bearing: ChatGPT captures a reference to the ORIGINAL
  `showOpenFilePicker` early, and the wrapper must be installed
  before that snapshot happens. `world: "MAIN"` needs no new
  permission (Chrome 111+ MV3).
- The existing isolated-world content script installs
  `installFsaMessageHandler`, which owns the private `MessageChannel`
  (see below) and turns port-borne `hold-request` messages into
  decisions. Same one-modal-at-a-time policy: another modal already
  open → reply `cancel`.

**Port-scoped wire contract (`src/content/main-world/fsa-messages.ts`).**
Hold-request and hold-decision traffic runs over a `MessagePort` the
isolated world creates and transfers to MAIN once at load — not over
`window.postMessage`. This closes the trivial "a page script
observes a `hold-request` on window, copies its `id`, and posts a
matching forged `hold-decision` on window" bypass: neither direction
is observable on window after the handshake, and a page script cannot
post a decision on the port because it has no reference to it. The
port is **not reachable via window messaging** post-handshake — see
the caveat below for what that does and does not mean.

Handshake (window.postMessage — one round trip, at load):

```text
MAIN     → { source:'alg-fsa-hello' }             (window.postMessage)
isolated → { source:'alg-fsa-port-handoff' }      (window.postMessage + [port2] in transfer list)
```

Steady state (port only — page scripts cannot observe or post here):

```text
MAIN     → { source:'alg-fsa', kind:'hold-request',  id, files:[{name,size,type}], blobs:File[] } (port2.postMessage)
isolated ← { source:'alg-fsa', kind:'hold-decision', id, decision:'upload-anyway'|'cancel' }      (port1.postMessage)
```

- The isolated world creates the `MessageChannel` on install, keeps
  `port1`, and transfers `port2` on the FIRST valid hello. Subsequent
  hellos are dropped (a `MessagePort` can only be transferred once).
- `id` correlates request and reply so concurrent pickers on the
  same page cannot cross wires.
- Both directions validate the shape with dedicated predicates
  (`isFsaHello`, `isFsaPortHandoff`, `isFsaHoldRequest`,
  `isFsaHoldDecision`). Handshake messages also require
  `event.source === window` so a cross-frame post cannot request the
  port. Foreign / malformed messages are ignored — a page can't forge
  a decision to bypass the modal, and can't forge a request to open
  it out of nowhere.
- **Bytes stay local; the reply stays decision-only.** The
  hold-request carries the picker's `File[]` alongside the metadata
  so the isolated-world inspector can extract + scan locally (A3.1
  closed the gap that had made the FSA picker the only site path
  never scanned). Files are structured-cloned onto the **private**
  `MessagePort` — after a successful handshake, steady-state port
  traffic is not observable to page listeners (the initial
  `alg-fsa-port-handoff` on `window.postMessage` IS observable to
  page listeners via `MessageEvent.ports`, which is the
  first-hello-hijack race described in the threat-model section
  below; the hold-request `File[]` itself is only ever posted on
  the port after handoff, so once handoff succeeds page scripts
  can neither read nor forge it). `upload-anyway`
  returns the **original picker handles** MAIN still holds, not
  anything derived from the isolated-side clone; the site sees the
  same handles a native picker call would have produced, byte-for-
  byte. (Whether the browser's structured-clone shares the underlying
  byte sequence between the two `File`s is implementation-defined
  per W3C File API + WHATWG structured-clone — Chrome typically
  shares, since `Blob` / `File` are immutable. The byte-identical
  result the site sees does not depend on that: it comes from MAIN
  returning its untouched originals.) The reply back to MAIN carries
  a `decision` string only — no matched values, no extracted text —
  and MAIN drops its `File[]` reference the moment the decision
  resolves. A1's "hold references only, don't read contents until
  the inspector needs to" invariant still applies.

**Threat model — MAIN-world limits and handshake race.** The MAIN-world
script shares a JavaScript realm with the page (that is what makes
patching `window.showOpenFilePicker` visible to ChatGPT in the first
place). Two consequences follow:

1. **First-hello-hijack**: `window.postMessage(handoff, origin, [port2])`
   exposes the transferred `port2` through `MessageEvent.ports` to any
   window `message` listener. A page script that posts its own
   `alg-fsa-hello` before our MAIN hook does can claim the one-shot
   `port2` (MessagePort transfer is first-come-first-served). The
   isolated handler then has no port to hand our hook, and every
   subsequent picker call would hang were it not for the fail-open
   below.
2. **Realm patching**: a hostile page could patch `MessageChannel`,
   `postMessage`, `addEventListener`, etc. before our MAIN-world
   script runs. No cryptographic defence exists at this layer — a
   shared JS realm precludes it.

**Fail-open on handshake failure.** `requestPort` in
`src/content/main-world/fsa-hook.ts` runs a bounded
`FSA_HANDSHAKE_TIMEOUT_MS` (2 s) timer. On timeout — hijack, isolated
never loaded, or the extension disabled mid-load — `askIsolatedWorld`
returns `'upload-anyway'` and the wrapper releases the original
handles. A subsequent picker call gets a fresh handshake attempt.
`askOverPort` runs a longer `FSA_DECISION_TIMEOUT_MS` (120 s) as a
safety net for isolated-world outages that happen after handshake,
also fail-open. This is what keeps document protection at **warn,
never block** even in adversarial conditions: a broken or hijacked
extension MUST NOT hang the user's picker or throw a spurious
`AbortError`.

The private-port design still eliminates the trivial forge-on-window
bypass and prevents in-flight decision snooping. It does not claim
bypass-proof status against a hostile site.

**Flag-OFF invariant.** MAIN world cannot read the isolated-world
flag directly (separate JavaScript contexts), so the wrapper always
sends a `hold-request`. When the flag is OFF (or the extension is
globally disabled), the isolated-world handler replies
`upload-anyway` immediately **without touching `request.blobs`** —
no extraction, no detection — and without opening a modal. The
wrapper returns the original handles and the site sees a native
picker call. A dedicated guard test asserts this end-to-end.

**A3.1 — scan wiring on the FSA path.** When the flag is ON and no
other modal is open, the isolated handler runs `inspectFiles(request.blobs)`
and routes the pending inspection through the shared
`resolveDecision` seam (`FsaHandlerDeps.resolveDecision`, which
production wires to `resolveDocumentDecision` — the same helper the
change / drop / paste path uses). Same `inspectFiles`
(`src/content/file-inspector.ts`) both file paths call — same
extraction, same V1.1 detector, same `AggregateScanResult`. The
helper branches on `aggregate.state`: `clean` auto-resolves
`upload-anyway` without ever opening a modal; `sensitive` /
`unable_to_inspect` open the warning modal in the matching view. A
parity test in `tests/fsa-isolated.test.ts` locks the two paths'
outputs together by running the same file through both.

**Silent release, no re-attach.** Upload-anyway returns the exact
handles the native picker returned — the site cannot tell we were
in the loop, and there is no re-attach nudge here (unlike the
`drop` / `paste` A1 fallback paths, which arm the pass-through
guard). Cancel throws `new DOMException('The user aborted a request.', 'AbortError')`,
which is byte-for-byte what the native picker throws on cancel;
consumers handle it exactly as they already do.

**Double-wrap guard.** The wrapper marks itself with
`__algWrapped = true`; a second `installFsaHook` call is a no-op.
Prevents nested wrapping if the MAIN-world script is re-injected
(dev hot reload, defensive re-runs).

**Sites in scope.** The MAIN-world entry is registered against the
same 5-site host list as the isolated content script. In practice
the wrapper only fires on sites that call `showOpenFilePicker` —
ChatGPT is the primary consumer today; other sites currently use
`<input type="file">` and are unaffected. Copilot document
protection remains deferred per A1's scope.

## Local document text extraction (V1.2 A2 — flagged OFF)

A1 held files but never read their contents. A2 adds the extraction
layer that turns a held file's bytes → plain text so A3 can run the
existing detector over that text. **A2 does NOT run detection**
(`file-inspector.ts` still returns `findings: []`) and does NOT
change the UI. It replaces the A1 stub inspector with a real
`extractText(file)` step and defines the honest `unable_to_inspect`
state that A4 will surface.

**Gate B decision: NO OCR.** Extract the _text layer_. Files without
one (scanned PDFs, images, encrypted docs) get `unable_to_inspect`,
never a silent pass.

**Files:**

- `src/content/extraction/extract.ts` — public `extractText(file)`;
  format sniffing (magic-bytes first, extension/MIME as tiebreaker);
  20 MB size cap; 10 s per-file timeout via `Promise.race`; global
  try/catch that classifies errors into `encrypted / no-text-layer /
too-large / timeout / unsupported-type / parse-error / empty`.
  `extractText` NEVER throws.
- `src/content/extraction/formats/pdf.ts` — pdf.js text-layer
  extraction. Security posture: `isEvalSupported: false`,
  `disableFontFace: true`, `useSystemFonts: false`,
  `disableAutoFetch: true`, `disableStream: true`. Worker is
  BUNDLED LOCALLY (Vite `?worker` suffix — see
  `manifest.web_accessible_resources`).
- `src/content/extraction/formats/xlsx.ts` +
  `src/content/extraction/formats/xlsx.worker.ts` — SheetJS parsing
  runs in a terminable Web Worker (see
  "XLSX Worker + patched SheetJS sourcing" below). Macros are never
  executed (SheetJS ignores the `vbaProject` stream).
- `src/content/extraction/formats/docx.ts` — jszip → `word/document.xml`
  → primitive `<w:t>` scan with `<w:p>` / `<w:br>` breaks; no
  mammoth, no HTML conversion.
- `src/content/extraction/formats/pptx.ts` — jszip → `ppt/slides/slide*.xml`
  in numeric order (`slide1` before `slide10`) → `<a:t>` scan.
- `src/content/extraction/formats/text.ts` — `file.text()` for
  `.txt`, `.md`, `.csv` (and anything the sniffer routes as text).

**Lazy loading (bundle discipline).** Every format module is loaded
via dynamic `import('./formats/...')` from `extract.ts`. The main
content bundle (`dist/assets/index.ts-*.js`) stays lean:

```text
main content bundle              ~40 KB (was ~36 KB pre-A2)
pdfjs-dist chunk                 ~427 KB (loaded only on a PDF)
pdf.worker chunk                ~1187 KB (loaded only on a PDF)
xlsx chunk                       ~332 KB (loaded only on an .xlsx)
jszip chunk                       ~97 KB (loaded only on docx/pptx)
docx / pptx / text extractors      <2 KB each (jszip pulled in on demand)
```

A lint-style test (`tests/extraction/lazy-load.test.ts`) enforces
this by rejecting a top-level `import ... from 'pdfjs-dist' | 'xlsx' | 'jszip'`
in any file on the main content-script path (`content/index.ts`,
`document-flow.ts`, `file-inspector.ts`, `extraction/extract.ts`).
Flag-OFF / paste-only sessions never load any of these chunks.

**Zero-network invariant.** A dedicated test
(`tests/extraction/no-network.test.ts`) stubs `fetch` and
`XMLHttpRequest.prototype.open` to throw, runs `extractText` across
every format, and asserts neither was ever called. pdf.js runs
locally with the bundled worker and no font fetching. No parser has
a CDN dependency at runtime.

**Guards.**

- `MAX_EXTRACTION_BYTES = 20 MB` — enforced BEFORE the sniffer or
  any parser is invoked (a hostile 500 MB "pdf" cannot force pdfjs
  to allocate anything).
- `EXTRACTION_TIMEOUT_MS = 10 s` — races the parser via
  `Promise.race`; on timeout, the parser's promise is orphaned and
  its ArrayBuffer references drop as soon as it settles.
- Every extractor is wrapped in try/catch; classified errors
  (`EXTRACTOR_ERROR_ENCRYPTED`, `EXTRACTOR_ERROR_NO_TEXT_LAYER`)
  become `encrypted` / `no-text-layer`, everything else becomes
  `parse-error`.

**In-memory only.** Extracted text is attached to the
`FileInspectionEntry` returned by `inspectFiles` and never leaves
memory: no `chrome.storage.local` writes, no `postMessage` payload
(the A1.1 FSA channel already carries metadata only), no DOM
insertion. The A5 event log stays metadata-only.

**Inspector wiring (unchanged shape, new async).** Both the FSA
picker path (`fsa-isolated.ts` → `document-flow.holdFiles`) and the
change / drop / paste paths (`content/index.ts` → `holdFiles`) funnel
through `inspectFiles`. Making the inspector async gives both paths
extraction "for free" with no additional plumbing in the
orchestrators. Detection over the extracted text is A3's job.

**Manifest.** No new permissions. `web_accessible_resources` gains
`assets/pdf.worker*.js` AND `assets/xlsx.worker*.js` (both
wildcarded because the chunk hash changes per build) so both
workers are reachable by the content script from the extension
origin.

**Worker URL invariant (A4.1 / issue #39, refined A4.2).** pdf.ts +
xlsx.ts originally spawned their worker chunk via Vite's `?worker`
factory, which resolved the chunk's URL against the PAGE origin in
the content-script bundle — `https://<host>/assets/pdf.worker-<hash>.js`
→ 404 → Worker never loaded → extraction hung until the 10 s
timeout fired. A4.1 fixed the URL by importing the chunk with
`?url`, routing it through `chrome.runtime.getURL()`, and spawning
`new Worker(chrome-extension://…, {type:'module'})`. Guard:
`assertExtensionOriginWorkerUrl` throws if the resolved URL doesn't
sit on the active extension's origin, catching cross-extension
hijack (the qualified-URL path) and stubbed-getURL regressions (the
resolved path).

**A4.3 refinement — self-contained workers.** A4.2's XLSX path used
`import xlsxWorkerUrl from './xlsx.worker.ts?url'`, which is a Vite
footgun: `?url` on a TypeScript module returns the raw source as a
`data:video/mp2t;base64,<raw-TS>` static asset. The built chunk was
a ~3 KB shim exporting that data URL, and the blob-spawned worker
ran uncompiled TypeScript that threw on the first `import`. Every
real `.xlsx` upload on claude.ai came back `parse-error`. Fix: the
import is now `?worker&url` (Vite compiles + bundles the worker,
returns the built chunk's URL — ~360 KB with SheetJS inlined), the
`vite.config.ts` `worker` clause forces `format: 'iife'` +
`inlineDynamicImports: true` so the worker is fully self-contained
(a blob module worker can't resolve a relative `./chunk-hash.js`
import against its own origin), and xlsx.ts spawns as CLASSIC (no
`{type: 'module'}`) to match. A runtime guard in
`spawnExtensionWorkerFromBlob` detects the `data:video/mp2t` raw-
shim shape and throws with a clear message so this footgun surfaces
at spawn time — not four seconds later as a generic `parse-error`.
The pdf.js worker is untouched by the Vite `worker` config (it's
imported via `?url` on the pre-built self-contained `.mjs` file,
not `?worker`) and its blob module-worker path remains intact.

**A4.2 refinement — strict-CSP sites.** claude.ai (confirmed) — and
other strict-CSP surfaces likely to follow — reject
`new Worker(chrome-extension://…)` from a content-script context
even when the resource is in `web_accessible_resources`: the page's
`worker-src` clause doesn't allow the extension scheme. Verified
in-page that `blob:` workers (classic and module) ARE allowed on
all four current target sites. So the extractors now:

1. Resolve the extension URL exactly as before
   (`resolveExtensionWorkerUrl`), preserving the same-origin
   invariant against the active extension.
2. `fetch(extensionUrl)` from the content-script context — content
   scripts can fetch their own WAR resources without extra
   permissions and without triggering the page's `connect-src`
   (extension-privileged fetch).
3. Wrap the response body in a `Blob({type:'text/javascript'})` and
   spawn `new Worker(URL.createObjectURL(blob), {type:'module'})`.
4. Revoke the object URL on the next microtask — the browser has
   already initiated the worker fetch synchronously during
   `new Worker(...)`, so revoke doesn't tear the Worker down.

The single seam is `spawnExtensionWorkerFromBlob`; a direct
`new Worker(chrome-extension://…)` would silently regress on
strict-CSP sites, so the helper is where the invariant lives.
Fallback if any site also blocks `blob:` workers: move extraction
to an offscreen document — not needed for the current four.
Invariants pinned by `tests/extraction/worker-url.test.ts` (fetch
source is chrome-extension, spawn URL is blob:) and the pdf spawn-
site test in `tests/extraction/hardening.test.ts`.

`verify:sw` and the "does not collect data" declaration are
re-verified.

## XLSX Worker + patched SheetJS sourcing (V1.2 M6 release blocker)

M6 (issue #31) remediates the two HIGH-severity SheetJS
vulnerabilities that shipped in `xlsx@0.18.5` alongside A2 (behind
the OFF flag). Both must land before `DOCUMENT_PROTECTION_ENABLED`
is turned on:

- **CVE-2023-30533** — Prototype Pollution (SheetJS ≤ 0.19.2)
- **CVE-2024-22363** — ReDoS (SheetJS ≤ 0.20.1)

**Patched SheetJS sourcing.** SheetJS no longer publishes to npm;
the fixed builds live on the official CDN. `package.json` and the
lockfile pin the SheetJS CDN tarball
(`https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz` — a version
≥ 0.20.2 that patches both CVEs). The tarball is downloaded ONCE
at build time (or the first `npm install` after checkout) and
resolved by npm's integrity hash from the lockfile on every
subsequent install. Nothing about this changes runtime behaviour:
the extension still makes zero network requests at runtime — the
no-network test in `tests/extraction/no-network.test.ts` asserts
that.

**XLSX Worker.** `XLSX.read` and `XLSX.utils.sheet_to_csv` are
synchronous; a hostile workbook (ReDoS payload, pathological cell
graph) can peg the main thread and the A2 10 s timeout cannot
preempt it. `src/content/extraction/formats/xlsx.ts` now spawns
`xlsx.worker.ts` (a Vite `?worker` chunk) per extraction and
transfers the ArrayBuffer for zero-copy handoff. The worker imports
SheetJS at module load; when the caller's `AbortSignal` fires,
`worker.terminate()` drops the entire parse context (stack, buffer,
workbook state) in one shot.

**Wire contract.** Kept tiny so the worker bundle stays small:

```text
main → worker  { buf: ArrayBuffer }              (transferred)
main ← worker  { kind: 'text', text: string }
main ← worker  { kind: 'reason', reason?: string }
```

**Test coverage** — `tests/extraction/hardening.test.ts`:

- Real (inline-fake) worker path produces the same CSV output as the
  A2 sync path — every existing docx/pptx/xlsx / no-network test
  goes through the Worker seam via `tests/setup.ts`.
- Hostile worker (never replies) + `AbortController.abort()` →
  `worker.terminate()` is called, extractor resolves with
  `unable_to_inspect / timeout`.
- Already-aborted signal short-circuits with `timeout` WITHOUT
  spawning a worker.

**Test seam.** `xlsx.ts` exports `__setXlsxWorkerFactoryForTesting`
so `tests/setup.ts` can install a synchronous in-memory factory
(jsdom has no `Worker`); every extraction test runs the real
SheetJS parse via this seam. Individual tests can also pass an
inline `workerFactory` option per call (used by the
termination-on-abort tests).

## Document detection integration (V1.2 A3 — flagged OFF)

A2 turned every held file into `entry.extraction` but left
`findings: []`. A3 plugs the existing **V1.1 detector verbatim**
(`detectDetailed` from `src/detector/engine.ts`) over that extracted
text, folds the outcome into a `DocScanResult`, and rolls per-file
results up into an `AggregateScanResult` for A4's headline UX. No
new detector code, no new rules — the paste path and the document
path share one engine.

**Files:**

- `src/content/extraction/scan-result.ts` — pure types +
  `scanResultFor()` (per-file) + `aggregateScanResults()` (fold).
- `src/content/file-inspector.ts` — `inspectFiles` now runs
  `detectDetailed(extraction.text)` per entry when
  `extraction.status === 'extracted'`; skips `empty` and
  `unable_to_inspect` (no text to scan). Adds `MAX_SCAN_CHARS =
2_000_000` size guard and a per-file try/catch that degrades a
  detector throw to `unable_to_inspect / scan-error` without
  crashing the pool.
- Re-exports `isMaskable` so A4/A5 gate on the same predicate the
  inspector uses.

**Scan-result state (`DocScanResult`):**

```text
extraction.status === 'extracted'    → run detector →
  filter(isMaskable).length > 0        → { state: 'sensitive',
                                            maskableCount, categories,
                                            hasCriticalOrHigh }
  else                                 → { state: 'clean', … zeros }
extraction.status === 'empty'        → { state: 'clean', … zeros }
extraction.status === 'unable_to_inspect'
                                     → { state: 'unable_to_inspect',
                                          reason: extraction.reason }
```

`isMaskable` is the **single "counts as sensitive" gate** — it
mirrors the paste path (clinical-context / LOW findings never mask
alone), so an ICD/CPT-only document stays `clean`. The A4 modal
picks its copy from `scan.state` and its count from
`scan.maskableCount`.

**Aggregate roll-up (`AggregateScanResult`).** Any file `sensitive`
→ aggregate `sensitive`; else any `unable` → aggregate
`unable_to_inspect`; else `clean`. Carries `totalMaskable`,
deduplicated `categories`, `anyCriticalOrHigh`, and per-state file
counts.

**Scan-size guard.** Extracted text over `MAX_SCAN_CHARS`
(2 000 000 chars, chosen so a large PDF still fits but a
document-scale hostile input can't peg a per-rule regex). Text over
the cap is refused — file becomes `unable_to_inspect /
too-large-to-scan` rather than being silently truncated and reported
as `clean`. The V1.1 rules were tuned on paste-sized inputs; a
detector-side fix for any per-rule backtracking pathology found on
larger inputs is deferred to a future detector-focused PR, per the
"no `src/detector/**` changes in A3" rule.

**Per-file try/catch.** Each `detectDetailed` call is wrapped so
that a single hostile file (unexpected regex path, adversarial
input) can only degrade that one file to `unable_to_inspect /
scan-error`; the pool continues and siblings still get results. The
inspector remains async and never rejects.

**Metadata-only discipline (A5 forward-compat).** The scan RESULT
(`state / maskableCount / categories / hasCriticalOrHigh / reason`)
carries no matched-value bytes and is safe to log. `Finding.value`
(the matched text) stays in memory only — never persist / log /
postMessage it. A5's event log will consume `DocScanResult`, not
`Finding[]`.

**Parity.** A dedicated test asserts `detectDetailed(text)` returns
identical findings whether reached via the paste path or the
document path — no divergent behaviour is possible because both
call the same function.

**Flag OFF.** Nothing above runs unless `documentFlowActive()` opens
`inspectFiles`. Existing paste + A1 + A1.1 + A2 tests stay green.

## Document warning modal (V1.2 A4 — flagged OFF)

A4 replaces the A1 placeholder confirm modal with the real warning
UX and unifies the two hold paths (change/drop/paste via
`document-flow.ts`, ChatGPT FSA via `fsa-isolated.ts`) onto a single
decision helper so their behavior cannot drift. Product rule:
**documents scan-and-WARN, never block.** Clean files auto-proceed
with NO modal; the modal appears only for `sensitive` or
`unable_to_inspect`.

**Shared decision helper (`src/content/document-decision.ts`).**
Both hold paths funnel through:

```text
resolveDocumentDecision(inspectionPromise, { opener })
  → 'upload-anyway' | 'cancel'
```

Branch on the A3 aggregate `DocScanResult`:

- `clean` → resolve `'upload-anyway'` with **no modal shown**. On
  the change/FSA paths this is a silent release; on drop/paste the
  release step needs a re-attach, and the nudge copy is reworded
  as informational ("No sensitive items found. Drop/paste the file
  again to send it to the site.") because the user was never
  warned in the first place.
- `sensitive` → open the modal in the sensitive view:
  "N sensitive items found in this file" (or "…across M files"),
  friendly category chips (`healthcare_patient_id`→"Patient
  identifiers (MRN)", `identity`→"Personal identity",
  `government_financial`→"SSN / financial", `provider_id`→"Provider
  ID (NPI)", `developer_credential`→"Credentials"), and an
  emphasised "Includes high-severity items." line when
  `hasCriticalOrHigh` is true. Primary is **[Upload anyway]**.
- `unable_to_inspect` → open the modal in the unable view with a
  reason-aware sub-line: encrypted / no-text-layer / too-large /
  timeout / unsupported-type / parse-error / scan-error each get
  a distinct honest copy. Primary is still **[Upload anyway]** — a
  file we couldn't read is not proof it's dangerous.

**Cancellable "Checking…" state.** Extraction can take up to
`EXTRACTION_TIMEOUT_MS` per file; the helper races
`inspectionPromise` against a `FLICKER_DELAY_MS` (250 ms) timer:

- Inspection wins → route straight to the terminal state (or the
  clean auto-release) — no spinner flash.
- Timer wins → paint the scanning view: heading "Checking this
  file…" + an **indeterminate progress bar** (a moving indigo strip
  on a dim track — no percentage, since extraction time is
  file/parser-dependent and a knowable value would be dishonest) +
  Cancel. The container carries `role="status"` + `aria-live="polite"`
  - `aria-busy="true"` so screen readers announce it without focus
    moving, and `aria-busy` flips to `"false"` when the view
    transitions to sensitive / unable. A `prefers-reduced-motion`
    fallback drops the animation to a static translucent band. When
    inspection subsequently resolves, the helper transitions the SAME
    modal instance in-place (`ctrl.showSensitive(...)` /
    `ctrl.showUnable(...)` / `ctrl.close('upload-anyway')` on clean).
    If the user cancels during scanning, the helper honours it — even
    if the eventual inspection would have been sensitive — and the
    document-flow orchestrator returns without awaiting inspection so
    the modal closes instantly rather than blocking on extraction.

**Modal controller (`src/content/document-modal.ts`).** The V1.1
Shadow-DOM patterns are reused verbatim (closed root, focus trap
over primary → secondary → close, Escape / × / backdrop cancel,
capture-phase keydown so ChatGPT/Claude's Enter-to-send doesn't
fire while the modal is up, focus returns to the opener on close).
A4 replaces `showDocumentModal(opts)` with `openDocumentModal({opener})
→ DocumentModalController` so the decision helper can start in the
scanning view and transition to a result view without unmounting.

**Metadata-only rendering.** The modal API accepts only
`totalMaskable`, `categories`, `hasCriticalOrHigh`, `fileCount`,
`reason` — never `Finding.value`. A dedicated component test
asserts a known SSN literal is absent from the modal's shadow DOM
after `showSensitive(...)`. This mirrors A5's metadata-only event
log discipline; no clean-copy / remove-item controls exist in
V1.2.

**Flag OFF.** `documentFlowActive()` (paste path) and `isActive`
(FSA path) still gate the entire chain. When the flag is off no
inspection runs, no modal opens, and the site sees byte-for-byte
native behaviour.

## What this architecture explicitly does NOT include in V1

- React or any UI framework
- Server backend
- User authentication
- Database
- Analytics or telemetry
- AI-based classification (ML models, embeddings)
- Cross-device sync
- Browsers other than Chrome

## V1.3 M1 — Protection at Send: submit-scan core (flagged OFF)

M1 adds the **site-agnostic** state machine that will gate a message
send on a scan of the composer, without wiring it into any site yet.
Adapters (M2/M3) intercept the user's Enter / Send-click, call
`SubmitCore.handleSendIntent`, and — per the M0 spike — resume the
send by re-clicking the site's own Send button. Nothing in the live
content script consults the core in M1, and the flag
(`src/content/submit/submit-flag.ts`, `isSubmitProtectionEnabled()`)
defaults to **OFF**, so M1 is a zero-behaviour-change merge.

Files: `src/content/submit/submit-core.ts` (machine), `fingerprint.ts`
(risk-shape dedup key), `submit-flag.ts`. Test-only adapter:
`tests/helpers/fake-submit-adapter.ts`.

**States.** `IDLE → HELD_SCANNING → (DECISION) → RESUMING → SUBMITTED`,
with `FAILED_OPEN` off the scanning phase and terminals
`RETURNED_TO_EDIT` / `ADAPTER_DISABLED`.

**The invariant that outranks everything.** No timer and no failure
path may ever auto-submit content a scan has flagged. Fail-open is a
property of the _automated_ phases only:

- **Watchdog-A (scan)** — armed on `HELD_SCANNING` (composer read +
  detection + any pending-file wait). Expiry or any throw →
  `FAILED_OPEN` → the send proceeds and a metadata-only
  `unable-to-inspect` event (`eventType: 'submit'`) records the
  incomplete protection. Budget `SCAN_WATCHDOG_MS` (250 ms initial).
- **DECISION** — deliberately **no auto-send timer**. The send stays
  held until the user chooses `proceed` or `return-to-edit`. The
  optional liveness guard (`DECISION_LIVENESS_MS`, default `null`)
  may only ever resolve to `RETURNED_TO_EDIT`. A throw inside the
  decision UI also lands on `RETURNED_TO_EDIT`. Test-pinned by
  "DECISION never auto-sends".
- **RESUMING** — the resume closure is idempotent (adapter `resume()`
  at most once, one optional fallback). `'failed'` increments a
  per-adapter counter; at `RESUME_FAILURE_KILL_THRESHOLD` (3) the
  adapter is disabled for the session (`ADAPTER_DISABLED`), the core
  stops taking sends for it (`handled: false` → native send works),
  and `submitKillSwitch` `{adapterId, ts}` is written so the popup
  can say so. A user is never left silently unable to send.

**Re-entrancy.** One in-flight send per `(tab, composer)`; a second
intent during HELD/DECISION/RESUMING coalesces onto the in-flight
promise — never a second submission.

**Dedup.** The detection result is fingerprinted as
`category:count|…` (maskable findings only, sorted) in memory,
scoped to `(tab, composer)`. An acknowledged fingerprint skips the
modal; any change in category or count re-warns. **Intentional
trade-off:** keyed on risk _shape_, not identity — swapping one SSN
for another after acknowledging does not re-warn, because the
alternative (hashing matched values) would keep a derivative of the
content in memory. Fingerprints are **never** written to
`chrome.storage` — release blocker, test-pinned.

**Event log.** `AlgEventType` gains `'submit'`; the seven-field moat
rule is unchanged. Actions used: `auto-cleared` (clean), `as-is`
(proceed / dedup-skip), `cancelled` (return-to-edit / liveness /
decision error), `unable-to-inspect` (fail-open).

## V1.3 M2 — Protection at Send: ChatGPT adapter (flag still OFF in main)

M2 makes ChatGPT the first live site for the M1 submit-scan core.
The core is unchanged; M2 adds the site adapter, the decision-UI
seam, the content-script wiring, and the kill-switch session-clear.
The committed `SUBMIT` flag (`submit-flag.ts`) stays **OFF**, so
`main` has zero live behaviour change — the adapter is only
installed when the flag reads true (a throwaway flag-ON build for
smoke, or a `globalThis` override).

Files: `src/content/submit/adapters/chatgpt.ts` (the `SubmitAdapter`),
`src/content/submit/submit-ui.ts` (decision seam), and
`src/content/submit/install-chatgpt.ts` (wiring), invoked from
`src/content/index.ts` for `adapter.id === 'chatgpt'` behind the flag.

**Interception.** A capture-phase `keydown` and `click` on `window`
(same ordering rationale as the paste path: window beats React's
root-delegated handlers and ProseMirror's keymap; `document_start`
wins registration ties). A real send intent is `Enter` with
`!shiftKey && !isComposing && keyCode !== 229` targeting the
composer, or a click whose composed path crosses an enabled send
button. **IME composition is never intercepted** (the `isComposing`
and legacy `keyCode === 229` guards are both checked — missing
either breaks CJK candidate confirmation). On an intent the adapter
`preventDefault` + `stopImmediatePropagation` + `stopPropagation`
synchronously, then calls `core.handleSendIntent`.

**Composer read.** Resolved at event time from the event's composed
path (fresh query fallback — the ProseMirror subtree re-mounts on
route/AB changes; never a stale cached reference), and read through
the SAME `stripHtmlToText` boundary walk the EMR paste fix uses, so
multi-paragraph `<p>`/`<br>` content doesn't glue into one line.

**Resume (transient activation).** `resume()` resolves the send
button FRESH (it only exists/enables once the composer has text and
swaps to a Stop button while streaming) and calls
`sendButton.click()` **synchronously** — the modal resolves its
outcome inside the proceed-click handler and nothing `await`s
between that click and the resume, so the click's user-activation
window is still live (M0 verified an untrusted click submits). A
re-dispatched Enter `KeyboardEvent` is the fallback when the button
is absent/disabled. A synchronous post-check returns `submitted`
(composer detached or its text changed/cleared), `failed` (no button
and no composer — could not even attempt; feeds the kill-switch
counter), or `unknown` (acted on a live composer but the text hasn't
cleared yet — race-safe: the core treats `unknown` as sent so a real
send never trips the kill switch). A re-entrancy flag makes the
adapter ignore the synthetic click/keydown it fires during resume,
so it never re-intercepts its own send.

**Kill-switch session-clear.** The service worker clears
`submitKillSwitch` on `chrome.runtime.onStartup` (once per browser
launch, not per SW respawn) and on install/update, so a transient
resume failure disables the adapter for the session only, never
across restarts. This lands before the flag is ever turned on.

**Counts.** The submit path logs metadata-only `eventType: 'submit'`
events and never increments the paste-path masked-items counter, so
a send-time warning can't inflate the headline count for content the
paste path already handled. Cross-flow paste↔send coordination is
M4.

## V1.3 M3 — Protection at Send: Claude + Gemini adapters (flag still OFF in main)

M3 adds the two remaining sites. M0 proved the resume gate LIVE on
all three: an untrusted `sendButton.click()` submits on ChatGPT,
Claude, AND Gemini (none check `isTrusted`). The committed `SUBMIT`
flag stays **OFF**, so `main` still installs nothing on any site.

**Refactor first.** The ~entirely site-agnostic adapter behaviour
(capture-phase keydown/click interception, the IME double-guard,
Shift+Enter suppression, the `resuming` re-entrancy guard,
`readComposerText` via `stripHtmlToText`, `resume()` button-first /
KeyboardEvent-fallback / synchronous-in-activation-window, and the
race-safe `postCheck`) moved into
`src/content/submit/adapters/base-submit-adapter.ts`, parameterised
by a `SiteSubmitConfig` (id, composer selector, send-button selector,
composer key, optional `matchesComposer` hook). Each site adapter is
now a thin config: `chatgpt.ts`, `claude.ts`, `gemini.ts`. The
untouched `tests/submit-chatgpt-adapter.test.ts` (21) is the
regression proof the extraction preserved behaviour. The three
`install-*.ts` files are thin wrappers over one shared
`install-submit.ts`; `index.ts` installs per host from a map, all
behind the flag.

**Confirmed live selectors** (logged-in, 5 Sep 2026):

| Site   | Composer                                   | Send button                                                                                                                                                                |
| ------ | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude | `[contenteditable="true"][role="textbox"]` | `button[data-testid="chat-input-send"]` (+ `aria-label="Send message"` fallback)                                                                                           |
| Gemini | `rich-textarea [contenteditable="true"]`   | `gem-icon-button.send-button button` (locale-independent; + `aria-label="Send message"` English fallback; Material icon button; the ONLY match once the composer has text) |

Gemini's composer lives inside the `<rich-textarea>` custom element,
so its config supplies a `matchesComposer` that also resolves the
host / anything inside it — the composed-path walk finds the composer
even when the custom-element boundary hides the inner contenteditable
from a naive `.matches`. Both sites resolve the send button FRESH at
resume time (it appears/enables only once the composer has text and
swaps to a Stop control while streaming, which the selector does not
match). Angular (Gemini) still emits `isComposing`/`keyCode 229`, so
the base IME double-guard covers CJK entry there too.

### Q7 — programmatic send paths NOT intercepted (documented coverage gaps)

Send protection covers a typed message sent via **Enter or the send
button**. These paths bypass both and are **out of scope** — any
future store-copy coverage claim must exclude them:

- **ChatGPT** — suggested-prompt chips (new chat / under a response),
  "Regenerate"/"Try again", editing a prior message and re-sending,
  Voice / advanced-voice auto-submit, "Continue generating".
- **Claude** — suggested/example chips, "Retry" (incl. model switch),
  editing a prior message and re-sending, Projects / prompt-template
  quick actions that submit directly.
- **Gemini** — suggestion chips, "regenerate"/"modify response"/show-
  more-drafts, Gemini Live / voice auto-submit, Deep Research "Start
  research" and canvas quick actions, editing a prior prompt and
  re-sending.

Each list is also recorded at the top of the site's adapter file.

**Gemini locale independence (gap closed, confirmed live 5 Sep 2026).** The send `<button>`'s parent is a `<gem-icon-button class="send-button … submit">` custom element — the `send-button`/`submit` classes live on that wrapper, not on the `<button>` (which is why an earlier `button.send-button` guess matched 0). The primary selector `gem-icon-button.send-button button` keys on that wrapper class, a **locale-independent** handle, so a _button-click_ send is intercepted in **every** locale; `button[aria-label="Send message"]` is retained only as an English fallback (resolves the same node). `button:has(mat-icon[data-mat-icon-name="arrow_upward"])` is a documented alternative but is broader (could drift onto other arrow-icon buttons), so it is not used as primary. Enter-to-send was already locale-safe in every build (it keys off the composer, not the button, and resume falls back to a re-dispatched Enter).
