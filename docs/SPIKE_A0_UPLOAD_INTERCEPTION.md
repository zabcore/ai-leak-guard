# Spike A0 — Document-upload interception feasibility

**Status:** timeboxed spike, no product code. Author: extension maintainers.
**Question:** Can the extension reliably stop or delay a file before the
host site (ChatGPT / Claude / Gemini / Perplexity / Copilot) begins
uploading it?

The rest of this document answers that question per site, per path,
with the technical reason behind each classification and a passive
observer script (`docs/spike-a0/upload-observer.js`) that a reviewer
runs in each site's DevTools to confirm the findings against live
behavior.

**Constraint reminder.** This spike does not ship any interception
code. It writes zero to `src/detector/**`, zero to `src/content/**`.
The V1.1.1 paste-flow behavior is byte-for-byte unchanged; every
existing test still passes. `npm run build` produces the same
extension.

---

## The single question, and why "reliably" is the whole answer

The technique that would intercept a file mirrors the one V1.1 uses for
paste: register a **capture-phase listener on `window`** at
`document_start`, and on the interesting event
(`change` on a file input, or `drop` on the composer) call
`stopImmediatePropagation()` so no site handler ever runs. If the site
never sees the event, it can never fire the upload request.

The DOM guarantees that make this work for paste (see
`docs/ARCHITECTURE.md`, section "Paste interception ordering") apply
equally to `change` and `drop`:

- A `window` capture listener runs before any `document` /
  `#root` / editor-element capture listener — different `EventTargets`,
  and the browser traverses window → document → … → target.
- Content-script `run_at: document_start` beats the page's own scripts
  to registering listeners on the same target (the only case where
  registration order matters). See the V1.1.1 manifest.

So **the mechanism exists**. What the spike has to establish is whether
each site (a) actually routes file selections through a
window-observable `change` event, (b) routes drops through a
window-observable `drop` event, and (c) doesn't have a second seam
(monkey-patched fetch, WebSocket-based upload, in-Worker file handoff,
etc.) that bypasses those events.

The observer script measures (a) and (b) directly. Point (c) is
observable indirectly: after we install the observer and the user
picks a file, if the network tab shows an upload request but the
observer logged NO `change` event, there is a hidden seam and
window-capture interception is off the table.

---

## Compatibility matrix

Legend:

- **SUPPORTED** — pre-upload interception is technically feasible with the
  window-capture mechanism, and the site's DOM makes the intervention
  cell reliable in the short term (weeks, not "forever").
- **PARTIAL** — the mechanism works today but has a specific reliability
  cliff (composer re-mounts, shadow DOM, upload-on-selection race with
  no delay budget, React onChange won't re-fire from a synthetic
  replay). Buildable with monitoring, not a "set and forget" seam.
- **UNSUPPORTED** — no observable interception point exists before the
  upload begins.

Cell format: `classification (technical reason)`.

| Site | Prompt-input adapter (V1.1) | File picker (change on input\[type=file\]) | Drag & drop | Multiple-file selection | Upload initiation | Cancel / release of a held file |
| --- | --- | --- | --- | --- | --- | --- |
| **ChatGPT** (`chatgpt.com`) | contenteditable / ProseMirror ([`chatgpt.ts`](../src/content/adapters/chatgpt.ts)) | **PARTIAL** — hidden `<input type="file">` in the light DOM; window-capture `change` + `stopImmediatePropagation` blocks React's synthetic dispatch before ChatGPT's upload fetch. Reliability cliff: composer is re-mounted on route changes and A/B'd, so the input node is transient — need a live discovery loop, not a one-time query. | **PARTIAL** — dropzone is a React onDrop bound in the composer container; window-capture `drop` fires before React's synthetic dispatch. Same re-mount caveat. | **PARTIAL** — a single `change` fires with `files.length > 1`; one stop point covers all. Replay path (see "Replay" below) is where multi-file gets ugly, not intercept. | **On selection.** ChatGPT begins the upload request immediately when `change` fires. Delay budget once we let the event through = zero. If we intercept, we must decide before releasing. | **SUPPORTED** — after holding a file we set `input.value = ''` and don't fire a replayed change. From the site's perspective nothing was ever selected. |
| **Claude** (`claude.ai`) | contenteditable / ProseMirror ([`claude.ts`](../src/content/adapters/claude.ts)) | **PARTIAL** — same shape as ChatGPT: hidden `<input type="file">`, React-managed. Same window-capture stop works; same re-mount caveat. Anthropic ships composer changes frequently. | **PARTIAL** — same as ChatGPT. Also handles pasted images through the paste path we already intercept in V1.1 — those come through `clipboardData.files` on the paste event; the V1.1 paste handler currently only reads `getData('text/plain')`, so images already pass through untouched. That's a THIRD path we'd need to also intercept for parity, and it lives in the same paste handler. | **PARTIAL** — same as ChatGPT. | **On selection.** Claude shows "Uploading…" immediately. Zero delay budget once the event escapes. | **SUPPORTED** — same input.value clear. |
| **Gemini** (`gemini.google.com`) | contenteditable inside `<rich-textarea>` custom element ([`gemini.ts`](../src/content/adapters/gemini.ts)) | **PARTIAL leaning UNSUPPORTED** — the composer lives inside a `<rich-textarea>` Web Component (Angular/Material). If the file input is inside a **closed** shadow root, our window-capture `change` will NOT see it (`change` is `composed: true` in the spec, but closed shadow roots hide the target's identity even when the event bubbles). If it's in the light DOM or an open shadow root, we're fine. **Observer must confirm** which model Gemini ships today (light-DOM count at install time + on mutation). | **PARTIAL** — `drop` is `composed: true` and bubbles through shadow boundaries; the target inside a closed root is retargeted to the shadow host, but the event itself is observable. Interception via `stopImmediatePropagation` still works because the host handler is behind the shadow root and receives the event AFTER our window listener. Angular's zone.js may re-dispatch events for change detection — not the same event object, but a follow-up microtask; the observer will show whether a second `drop` shows up. | **PARTIAL** — depends on whether Gemini allows multiple attachments. Observer to confirm; if yes, same "one `change` covers all" behavior. | **On selection.** Observed pattern for Google composer surfaces. Zero delay budget once released. | **SUPPORTED** — clear `input.value` (subject to shadow-root access). |
| **Perplexity** (`www.perplexity.ai`) | `<textarea>` ([`perplexity.ts`](../src/content/adapters/perplexity.ts)) | **PARTIAL** — Next.js/React composer with a hidden `<input type="file">` in the light DOM. Window-capture stop works. Same composer-churn caveat as ChatGPT / Claude. | **PARTIAL** — dropzone on the composer container; window-capture stop works. | **PARTIAL** — file upload availability is Pro-tier; matrix should be re-run against a Pro account before shipping. Observer will still show a `change` on a free account if the input exists but is disabled. | **On selection** (assumption — to confirm with the observer + Network tab). Zero delay budget. | **SUPPORTED** — same `input.value` clear. |
| **Copilot** (`copilot.microsoft.com`) | `<textarea>` ([`copilot.ts`](../src/content/adapters/copilot.ts)) | **PARTIAL** — React/Fluent UI composer with a light-DOM `<input type="file">`. Same window-capture stop applies. Fluent UI wraps inputs in its own hidden-input pattern; observer needs to confirm the visible element is the one bound to `change`. | **PARTIAL** — dropzone on the composer; window-capture stop applies. Copilot may route drops through its own event bus (undocumented); observer to confirm the `drop` fires on window at all. | **PARTIAL** — Copilot Pro allows multiple attachments; free tier has one at a time. | **On selection** for Copilot Pro flows (upload progress shown before Send). Zero delay budget. | **SUPPORTED** — same input.value clear. |

**Nothing lands at UNSUPPORTED with only static analysis in hand.** The
closest calls are Gemini (closed shadow root would flip picker to
UNSUPPORTED) and Copilot (undocumented event bus). Those two require
observer confirmation before a go/no-go call.

---

## Replaying a modified file to the host — a separate, thornier question

The spike question is scoped to **stopping** the upload. It is worth
flagging explicitly that "modal → user picks 'upload with redactions
applied' → hand a redacted file to the host as if the user had selected
it" is a **strictly harder** problem than intercepting:

- **Picker replay** — assigning `input.files = someOtherDataTransfer.files`
  is possible in Chrome (via a `DataTransfer` object), and dispatching a
  bubbling `change` event on the input works. React 18+ still tracks
  input change through the standard event bus for file inputs (unlike
  the special value-tracker for text inputs), so a synthetic `change`
  is picked up by React's `onChange`. **However**: `event.isTrusted`
  will be `false` on a re-dispatched event. Some framework helpers
  refuse to process untrusted events. React itself doesn't check
  `isTrusted`, but app-level guards might. Confirming this per-site
  is out of scope for A0 — it's an A1-shaped problem.
- **Drop replay** — this is much worse. Constructing a synthetic
  `DragEvent` with a `DataTransfer.files` list is only conditionally
  supported in Chrome (varies by version), and every synthetic
  `DragEvent` has `isTrusted: false`. Many drop handlers ignore
  untrusted drops. The realistic V1.2 pattern for drop is:
  intercept the real drop with our modal, then **route the "upload
  with redactions" path through the picker replay** (calling
  `input.click()` internally is blocked by trusted-user-gesture rules
  in Chrome, but we can hold the file, prompt the user, and on
  approval simulate a re-select via the picker path — subject to the
  same isTrusted caveats).

Bottom line for the go/no-go: even where "stop the upload" is
SUPPORTED, "replay a redacted upload" may need to be sold to users
as **"we redact by canceling and asking you to re-attach a clean
version"** rather than the seamless mask-in-place of the paste path.
That is a product decision, not a feasibility one — but it should
land on the same call as the go/no-go.

---

## Failure modes (the "reliably" in the question)

None of these are speculative — all four are known Chrome extension
patterns from the paste-interception work, projected onto the file-
upload surface:

1. **Composer re-mount.** ChatGPT and Claude re-render the composer
   subtree on route changes and A/B experiments. Any interception that
   depends on a static reference to `<input type="file">` breaks on
   re-mount. Mitigation: rely on window-capture events (which don't
   need the input reference) and only resolve the input reference at
   the moment we need to reset it after a hold.
2. **Shadow DOM.** Gemini is the current risk; more sites are moving
   toward Web Component composers. Closed shadow roots can hide the
   file-input node from `querySelectorAll` and (for `change` events
   specifically) can retarget the event target away from the input.
   The observer will surface this today; ongoing monitoring is needed.
3. **Zero delay budget.** All five sites appear to upload on selection.
   That means once we let the event through, we cannot "catch it on
   the way to the server". The only viable pattern is
   `stopImmediatePropagation` on the event and hold the file client-
   side while the modal is open. This is fine for the intercept
   question but constrains the UX (no "download progress preview then
   redact" pattern).
4. **isTrusted replay cliff** — see "Replaying" above.

---

## Instrumentation to confirm each cell

`docs/spike-a0/upload-observer.js` is a self-contained JS snippet the
reviewer pastes into DevTools → Sources → Snippets on each site. It:

- Reports the number of `<input type="file">` in the light DOM at load
  and on every DOM mutation that changes the count.
- Logs one structured line per `change` / `input` / `dragenter` /
  `dragover` / `drop` event that reaches the `window` capture phase,
  with `phase`, `target`, `currentTarget`, `composedPath`, and (for
  change) the `files` summary.
- Runs each listener passively — no `preventDefault`,
  `stopPropagation`, or `stopImmediatePropagation` anywhere. No writes
  to `input.files` / `input.value` / `fetch` / XHR. No network requests.

The reviewer runs it per site against the exact five paths listed in
the file header. If any site shows an upload request in the Network
tab with NO matching observer line, that site's cell flips to
UNSUPPORTED regardless of what the matrix says today.

---

## What this spike is NOT

- Not a design for V1.2. No UI mock, no scoring, no detector taxonomy
  for file contents.
- Not a parser or extractor. No PDF.js, no `docx` reader, no OCR.
- Not a webRequest / declarativeNetRequest experiment. The mechanism
  above stays inside content-script event handling; adding
  `webRequest` would require a new permission and belongs in A1.
- Not a proposal to add `webRequest` or `webRequestBlocking`. If A0's
  answer is "the DOM seam is enough", `webRequest` never enters the
  picture.

---

## Recommendation input for the go / no-go call

Two things worth putting on your side of the decision:

1. **Ship blocker for A1.** Gemini and Copilot need observer runs
   before A1 can start. If Gemini turns out to be closed-shadow-root
   for the picker, "5-site support parity" isn't achievable without
   a per-site shim, which changes the shape of A1 significantly.
2. **Product framing.** Even in the SUPPORTED / PARTIAL cells, the
   "replay" story is meaningfully worse than paste. A "cancel-and-
   re-attach" flow is defensible for a first release; a seamless
   in-place redaction is not, given the isTrusted / synthetic-
   DataTransfer cliffs. This should shape the A1 acceptance
   criteria, not be discovered in the middle of A1.
