# Spike M0 — Send interception + safe resume feasibility (V1.3 "Protection at Send")

**Status:** timeboxed spike, throwaway instrumentation only. No product
code. Nothing here ships. **M0 is blocking:** M1 adapter work waits on
the gate at the bottom of this document.

**The question:** not "can we intercept send" — it is "can we safely
**resume** send afterward." Once we `preventDefault` +
`stopImmediatePropagation` the user's Enter or Send-click, resuming means
re-dispatching, and every re-dispatched event carries `isTrusted: false`.
If a site's send path checks `isTrusted` (or relies on trusted-event
behaviour), the resume is a silent no-op and the user's message vanishes
while the extension has just told them it protected it. Q1 decides
go/no-go.

Instrumentation lives in [`spike/m0-send-intercept/`](../spike/m0-send-intercept/)
(plain-JS MV3, load-unpacked, no permissions, never published). The
per-site protocol is in its [README](../spike/m0-send-intercept/README.md).

---

## 1. What this spike could and could not verify

### 1.1 Live sites: **not reachable from the spike environment**

The spike was run from a sandboxed cloud container whose egress policy
refuses `CONNECT` to all four hosts (gateway answered **403** at the
proxy — a policy denial, not a login wall and not Cloudflare):

| Site                | Attempt                                 | Result                              |
| ------------------- | --------------------------------------- | ----------------------------------- |
| `chatgpt.com`       | headed Chromium + spike ext, logged-out | `net::ERR_TUNNEL_CONNECTION_FAILED` |
| `claude.ai`         | same                                    | `net::ERR_CONNECTION_RESET`         |
| `gemini.google.com` | same                                    | `net::ERR_TUNNEL_CONNECTION_FAILED` |
| `www.perplexity.ai` | same                                    | `net::ERR_TUNNEL_CONNECTION_FAILED` |

So **no live-site log line in this document is real.** Every per-site
Q1 verdict below is therefore **CONDITIONAL**, with the exact protocol
step and the exact console line that flips it to GO or NO-GO. The
owner's logged-in run (≈10 min/site, README table) is the M0 gate; this
document is the frame it drops into.

### 1.2 What was verified instead: the framework layer, on the real frameworks

The Q1 risk decomposes into two layers:

1. **Framework layer** — does React's synthetic event system, ProseMirror's
   keymap, and an Angular-style `addEventListener('keydown')` binding act
   on an `isTrusted:false` event at all?
2. **App layer** — does the _site's own_ handler check `isTrusted`, gate
   on hidden state, or keep the button disabled in a way a synthetic
   click can't satisfy?

Layer 1 is the bulk of the risk and is site-independent, so it was
measured directly. Three local fixture composers were built on the real
libraries and the spike extension's **actual resume harness** (the same
`content.js` the owner will load, with only `localhost` added to
`matches`) was driven by Playwright under xvfb, using CDP-generated —
i.e. `isTrusted:true` — Enter and Send-clicks as the "real" user action:

| Fixture             | Stands in for   | Built from                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `react-prosemirror` | ChatGPT, Claude | React 18.3 `createRoot` + ProseMirror `EditorView`; Enter bound in a `prosemirror-keymap` plugin, Shift-Enter → `splitBlock`; Send is React `onClick`, `disabled` while the doc is empty                                                                                                                                                                                                                                                               |
| `react-textarea`    | Perplexity      | React 18.3 + `<textarea>`; Enter in React `onKeyDown` (preventDefault + send), Shift+Enter falls to browser default; Send is React `onClick`, disabled while empty                                                                                                                                                                                                                                                                                     |
| `angular-shaped`    | Gemini          | **Structural model, not real Angular.** `<rich-textarea>` custom element with a light-DOM contenteditable child (per the A0 spike); Enter via `addEventListener('keydown')` filtered on `event.key`, exactly the shape Angular's `KeyEventsPlugin` compiles `(keydown.enter)` to; Send via `addEventListener('click')`. Angular's EventManager / KeyEventsPlugin / zone.js patch contain no `isTrusted` check, so a plain listener is a faithful model |

Each fixture has a `?guard=isTrusted` variant whose send handler
**refuses untrusted events** — the adversarial app-layer case — so the
run also proves the harness _detects_ the failure mode rather than only
the success.

**54 runs, 0 harness errors.** Full table in Appendix A.

---

## 2. The central finding

### 2.1 `isTrusted` does not matter to the frameworks. It only matters if the app checks it.

| Resume mechanism                                                                                        | Synthetic event `isTrusted` | react-prosemirror       | react-textarea          | angular-shaped          |
| ------------------------------------------------------------------------------------------------------- | --------------------------- | ----------------------- | ----------------------- | ----------------------- |
| **(a)** `sendButton.click()`                                                                            | `false`                     | **SUBMITTED** 2/2       | **SUBMITTED** 2/2       | **SUBMITTED** 2/2       |
| **(b)** `composer.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', keyCode:13, bubbles:true}))` | `false`                     | **SUBMITTED** 2/2       | **SUBMITTED** 2/2       | **SUBMITTED** 2/2       |
| **(c)** control — block, no resume                                                                      | —                           | BLOCKED-AS-EXPECTED 2/2 | BLOCKED-AS-EXPECTED 2/2 | BLOCKED-AS-EXPECTED 2/2 |
| (a) with app-level `isTrusted` guard                                                                    | `false`                     | **NO-OP** 2/2           | **NO-OP** 2/2           | **NO-OP** 2/2           |
| (b) with app-level `isTrusted` guard                                                                    | `false`                     | **NO-OP** 2/2           | **NO-OP** 2/2           | **NO-OP** 2/2           |

("2/2" = the block was triggered once by a real Enter and once by a real
Send-click; SUBMITTED = the marker string appeared in the conversation
thread outside the composer, `RESULT verdict:SUBMITTED via:marker-in-thread`.)

- React 18's root-delegated synthetic event system fires `onClick` and
  `onKeyDown` for untrusted events. (This is also why `@testing-library`
  works; it was never in serious doubt, but it is now measured in this
  exact harness.)
- **ProseMirror's keymap plugin accepts a synthetic `keydown` Enter** and
  runs the bound command. This was the least certain cell and it passed
  4/4 — relevant because ChatGPT and Claude both bind Enter in
  ProseMirror, not in React.
- A disabled Send button swallows `.click()` (browser behaviour). The
  fixtures disable Send while empty, exactly as ChatGPT does; after our
  block the text is still in the composer so the button is enabled —
  `buttonDisabledAtResume:false` on every (a) run. If a live site
  disables Send on some _other_ state, (a) is a no-op and the log shows
  `buttonDisabledAtResume:true`.
- With the adversarial guard, both mechanisms fail **identically and
  detectably**: `RESULT verdict:NO-OP`, `markerStillInComposer:true`,
  and the fixture's own rejection line. So a live NO-OP is not ambiguous.

**Conclusion for Q1 at the framework layer: GO.** The remaining risk is
entirely app-layer and is answered per site by one protocol step.

### 2.2 Prefer `button.click()`; keep the KeyboardEvent as the fallback

Both work on the frameworks. `button.click()` is preferred because it
enters the site's send path through the same handler and state checks a
user click does (disabled-when-empty, "stop generating" toggle, attach-
in-progress), it doesn't depend on which element holds focus after our
modal closes, and it needs no `keyCode`/`which` shims. The KeyboardEvent
path is the fallback for a site whose Send button is hidden, replaced by
a "stop" button mid-stream, or not discoverable; it requires focus back
on the composer and depends on `keyCode:13` being honoured (Chrome
honours it from the init dict; the harness shims it defensively).

Neither mechanism touches framework internals. **No React fiber, no
`__reactProps$` handler, no Angular injector is invoked** — which the
brief classifies as UNSUPPORTED, and which is also _impossible_ from a
content script (see 2.4).

### 2.3 The block itself is safe

Control runs (mode c) on all three fixtures, both triggers: after
`preventDefault` + `stopImmediatePropagation` + `stopPropagation` on the
window-capture listener, **nothing sent, the marker stayed in the
composer, the site's handler never ran** (`KEYDOWN-BUBBLE` never
appeared; no `NET`). The composer is intact for the user to keep editing
if the modal is cancelled. Same mechanism as the V1.1 paste path.

### 2.4 Two instrumentation findings worth carrying into M1

- **React internals are invisible from the isolated world.** The first
  harness pass reported `reactRoot:null` on the React fixtures. Cause:
  React's `__reactContainer$…` / `__reactFiber$…` expandos live in the
  page's JS realm; a content script's isolated world shares the DOM but
  not those properties. Root detection was moved to the MAIN-world
  sniffer (`REACT-ROOT` line). Consequence for M1: **no product content
  script can ever locate a React handler to call** — the brief's
  UNSUPPORTED clause is enforced by the platform, not just by policy.
- **Ordering proof is `defaultPrevented`, not root detection.** On
  every trusted Enter in every fixture: `KEYDOWN` at window-capture
  shows `defaultPrevented:false`, `KEYDOWN-BUBBLE` at window-bubble
  shows `defaultPrevented:true`. The site's handler ran _between_ our
  capture listener and the end of dispatch. That is the Q2 answer and
  it is a DOM-spec guarantee (window is the outermost target; React
  17+ delegating at the root container is still strictly inside it).

---

## 3. Per-site feasibility notes

Each Q1 is **CONDITIONAL** pending the owner's protocol run. The verdict
flips as follows, per site:

- **→ GO** when README step 7 (arm 3a, real Enter) logs
  `RESULT verdict:SUBMITTED via:marker-in-thread` **and** step 9 (same,
  triggered by clicking Send) does too.
- **→ GO (KeyboardEvent)** if step 7 is NO-OP but step 8 (arm 3b) is
  SUBMITTED — ship with (b) as primary for that site and note why.
- **→ NO-GO** if steps 7 **and** 8 both log `RESULT verdict:NO-OP` with
  `markerStillInComposer:true`. Do not redesign around it; bring it back.
- A `SUBMITTED via:send-like-network-request` **without** a `THREAD`
  line is _not_ a pass — open the Network tab and confirm the request
  carried the message (a 4xx on the re-dispatch is a NO-OP in disguise).

Architecture facts below come from the V1.1 adapters and the A0 upload
spike; everything marked **VERIFY** is a prior, not an observation.

### 3.1 ChatGPT (`chatgpt.com`)

- **Architecture.** React (Next.js) app; composer is a ProseMirror
  contenteditable (`#prompt-textarea`, `role="textbox"`); Enter is a
  ProseMirror keymap binding; Send is `button[data-testid="send-button"]`
  (`#composer-submit-button` on some builds), disabled while empty and
  swapped for a "Stop" button while streaming. Composer subtree is
  re-mounted on route changes and A/B experiments (A0 finding).
- **Q1 — CONDITIONAL GO.** Framework path (React + ProseMirror) proved
  6/6 on both mechanisms. Preferred resume: `sendButton.click()`. Live
  risks specific to ChatGPT: the Send↔Stop button swap (resolve the
  button _at resume time_, not at block time — the harness already does),
  and any `isTrusted` check in the app's send handler (**VERIFY**, step
  7). If `buttonDisabledAtResume:true` appears, the site gates Send on
  state we didn't preserve — try (b), report both.
- **Q2 — GO (spec + fixture).** Window-capture fires first; confirm
  `KEYDOWN-BUBBLE defaultPrevented:true` on a real Enter (step 1).
  `REACT-ROOT` should name the app root container.
- **Q3 — GO with one rule.** Read the composer from
  `event.composedPath()` / `event.target` at block time, never from a
  cached reference (re-mount cliff). `textContent` of the ProseMirror
  root is reliable; the `COMPOSER-AFTER-RAF` line (same `len`/`hash`
  one frame later) confirms no rerender changed it. A ProseMirror doc
  with multiple paragraphs yields no `\n` in `textContent` — M1 should
  walk `p`/`br` boundaries the same way `clipboard-text.ts` does for
  pasted HTML.
- **Q4 — GO.** Send filter: `key==='Enter' && !shiftKey && !isComposing
&& keyCode!==229`. Shift+Enter is a ProseMirror hard-break, never a
  send. IME: Chrome delivers `keyCode:229` + `isComposing:true` while a
  candidate is open, and the Enter that _confirms_ the candidate still
  has `isComposing:true`; only the next Enter is a send (step 3,
  **VERIFY** with a JP/CN/KR IME).
- **Q5 — VERIFY (step 4).** Prior: Enter sends; Ctrl+Enter / Cmd+Enter
  are not send chords on ChatGPT web. The spike treats Ctrl/Meta+Enter
  as a send chord for arming, so if the site honours one it is caught
  and logged (`ctrl:true` / `meta:true`).
- **Q6 — GO with the V1.1 rule.** Fixture: two rapid Enters → two
  `KEYDOWN`s, **one** send (the composer empties after the first; the
  second sends nothing). The live risk is the second Enter arriving
  _while our modal is open_: M1 must apply the V1.1 paste rule —
  additional send events are swallowed (`preventDefault` +
  `stopImmediatePropagation`) until the pending decision resolves.
  Rapid double-click on Send: same rule; the harness logs `detail:2`.
- **Q7 — see §4.**

### 3.2 Claude (`claude.ai`)

- **Architecture.** React app; composer is ProseMirror
  (`[contenteditable="true"][role="textbox"]`, class `ProseMirror`);
  Enter bound in ProseMirror; Send is `button[aria-label="Send Message"]`.
  Anthropic ships composer changes frequently (A0).
- **Q1 — CONDITIONAL GO.** Same framework path as ChatGPT, proved 6/6.
  Preferred resume: `sendButton.click()`. **VERIFY** step 7. Watch for
  a `disabled`/`aria-disabled` Send during the brief post-modal window.
- **Q2 — GO (spec + fixture).** Confirm step 1.
- **Q3 — GO,** same read-at-event-time rule as ChatGPT. Claude's
  ProseMirror also uses `<p>` per line — same boundary handling.
- **Q4 — GO,** same filter. **VERIFY** IME (step 3).
- **Q5 — VERIFY (step 4).** Prior: Enter sends **and Cmd/Ctrl+Enter
  also sends** on Claude web. If confirmed, M1's send filter for Claude
  must include the chord (the spike's `isSendChord` already does).
- **Q6 — GO with the V1.1 rule.** As ChatGPT.
- **Q7 — see §4.**

### 3.3 Gemini (`gemini.google.com`)

- **Architecture.** Angular app; composer is a contenteditable inside
  the `<rich-textarea>` custom element. A0 established that the
  contenteditable is in the **light DOM** (the V1.1 adapter matches
  `rich-textarea [contenteditable="true"]` and paste interception works
  there), so composer reads and KeyboardEvent dispatch have a reachable
  target. Send is a Material button (`aria-label` contains "Send").
- **Q1 — CONDITIONAL GO.** The Angular-shaped fixture passed 6/6, but
  it is a structural model, so Gemini carries the widest gap between
  fixture and live. Two Gemini-specific cliffs to watch in step 7:
  (i) Angular's change detection runs inside zone.js — a synthetic
  event _does_ go through the zone-patched `addEventListener`, so
  bindings fire, but if Gemini's handler reads composer state from a
  signal/observable updated on `input` rather than from the DOM, and
  our marker was inserted by `execCommand` (which does fire `input`),
  it should be current — confirm `composerBefore.len` on the `RESUME`
  line matches; (ii) if the Send button is inside a **closed** shadow
  root, `findSendButton` returns null (`RESUME ok:false reason:'no send
button found'`) → fall to (b). **If both (a) and (b) NO-OP here, swap
  Gemini → Perplexity** (brief's fallback; §5).
- **Q2 — GO (spec).** Angular binds at the element, far below window.
  Confirm step 1; `REACT-ROOT` will correctly report none.
- **Q3 — GO** for the light-DOM contenteditable. If a future Gemini
  build moves it behind a closed root, `DISCOVERY composerInShadow`
  flips and both reads and dispatch break — that is an UNSUPPORTED
  transition, watch for it.
- **Q4 — GO,** same filter. Gemini's own Enter handling already
  ignores `isComposing` (Google composers are IME-heavy). **VERIFY**
  step 3.
- **Q5 — VERIFY (step 4).** Prior: Enter sends; Ctrl+Enter unbound.
- **Q6 — GO with the V1.1 rule.**
- **Q7 — see §4.** Gemini has the most programmatic send paths of the
  four (Live, Deep Research, chips, Gems).

### 3.4 Perplexity (`www.perplexity.ai`) — the Gemini fallback

- **Architecture.** React (Next.js); composer is a plain
  `<textarea placeholder="Ask…">`; Enter handled in React `onKeyDown`;
  Send is `button[aria-label="Submit"]`. Queries go over a socket.io
  WebSocket — the spike's `WebSocket.send` wrapper covers it
  (`NET kind:'ws'`).
- **Q1 — CONDITIONAL GO, and the simplest of the four.** The
  `react-textarea` fixture is the closest fit in this spike and passed
  6/6 on both mechanisms; a `<textarea>` has no editor abstraction
  between the DOM and React. **VERIFY** step 7.
- **Q2 — GO (spec + fixture).**
- **Q3 — GO.** `textarea.value` — the most reliable read of the four.
- **Q4 — GO,** same filter; `<textarea>` Shift+Enter is the browser
  default newline.
- **Q5 — VERIFY (step 4).** Prior: Enter sends; Ctrl+Enter unbound.
- **Q6 — GO with the V1.1 rule.**
- **Q7 — see §4.** Perplexity's related-question chips are a major
  bypass and the coverage claim must say so.

---

## 4. Consolidated un-interceptable send paths (Q7 / brief A-5)

These are sends that bypass **both** Enter and the Send button. They are
**documented coverage gaps**: V1.3's "protection at send" claim must not
imply they are caught. Every item is a **prior** to be confirmed by
README step 10 — a `BYPASS` line (send-like request with no Enter / Send-
click in the preceding 3 s) is the confirmation; note the UI element
clicked next to each.

| Site           | Path                                                                                 | Why it bypasses                                        | Status |
| -------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------ | ------ |
| **ChatGPT**    | Suggested-prompt chips on a new chat                                                 | click on a chip element → immediate send               | VERIFY |
|                | Follow-up suggestion chips under a response                                          | same                                                   | VERIFY |
|                | **Regenerate** / "Try again" / model-switch regenerate                               | resubmits the last turn, no composer involved          | VERIFY |
|                | **Edit a sent message → Send** (the edit-turn's own button)                          | separate button, separate handler                      | VERIFY |
|                | **Voice Mode** (auto-submits transcription)                                          | no keyboard, no visible Send                           | VERIFY |
|                | Dictation (mic in composer) — **not** a bypass: fills the composer, user still sends | —                                                      | VERIFY |
|                | "Continue generating"                                                                | no user text                                           | VERIFY |
|                | Canvas / inline "Ask ChatGPT" actions on selected text                               | programmatic prompt                                    | VERIFY |
|                | GPT starter prompts, Projects instructions, scheduled tasks                          | programmatic                                           | VERIFY |
| **Claude**     | Starter chips on a new chat — likely **prefill only** (user still sends)             | if prefill-only, NOT a bypass — confirm which          | VERIFY |
|                | **Retry** on a response                                                              | resubmit, no composer                                  | VERIFY |
|                | **Edit a sent message → Save**                                                       | separate handler                                       | VERIFY |
|                | Artifacts inline "Ask Claude" / improve actions                                      | programmatic                                           | VERIFY |
|                | Dictation — fills composer (not a bypass)                                            | —                                                      | VERIFY |
|                | Projects "add content" is an upload path, not a send                                 | covered by V1.2 document flow, out of scope here       | —      |
| **Gemini**     | Suggestion chips (new chat and under responses)                                      | immediate send                                         | VERIFY |
|                | **Regenerate / Redo / Modify response** menu                                         | resubmit                                               | VERIFY |
|                | **Gemini Live** (voice, auto)                                                        | no keyboard/Send                                       | VERIFY |
|                | **Deep Research → "Start research"** button                                          | a _different_ submit button                            | VERIFY |
|                | Gems starter prompts                                                                 | programmatic                                           | VERIFY |
|                | **Edit prompt → Update**                                                             | separate handler                                       | VERIFY |
|                | Canvas "Ask" actions                                                                 | programmatic                                           | VERIFY |
|                | Mic dictation — fills composer (not a bypass)                                        | —                                                      | VERIFY |
| **Perplexity** | **Related / follow-up question chips** (very prominent)                              | click → immediate query                                | VERIFY |
|                | **Rewrite** (model/focus change)                                                     | resubmit                                               | VERIFY |
|                | Voice input with auto-submit on silence (some modes)                                 | no keyboard/Send                                       | VERIFY |
|                | Spaces / Collections "ask" entry points                                              | separate composer instance — may or may not be covered | VERIFY |
|                | Discover / Library links open pages, do not send                                     | not a bypass                                           | —      |

Common to all four: **any send that originates from a click on a
non-Send element is out of scope for V1.3's send interception** unless
M1 explicitly enumerates and intercepts that element per site, which is
a per-site selector cliff and should not be promised. The coverage
matrix should list "typed message sent via Enter or the Send button" as
the covered surface and the table above as known gaps.

---

## 5. Recommendation

**Build ChatGPT + Claude + Gemini, each conditional on README step 7
passing on the live site; swap Gemini → Perplexity if Gemini's steps 7
and 8 are both NO-OP.** Perplexity's `<textarea>` + React shape is the
simplest of the four and matched the fixture that passed most cleanly,
so it is a safe fallback, not a downgrade.

Resume mechanism for M1: **`sendButton.click()` resolved at resume
time**, with the re-dispatched `KeyboardEvent` as the per-site fallback
when the button is absent/disabled — never any framework-internal call.

### The hard gate (unchanged from the brief)

- Proceed past M0 only if **ChatGPT resolves cleanly** (step 7 or 8
  SUBMITTED with a `THREAD` line) **and at least one other site does**.
- If ChatGPT cannot be resumed by (a) or (b): **STOP** and bring the
  finding back. Do not redesign around it unilaterally.
- Any site that can only be resumed by invoking a React/Angular internal
  is **UNSUPPORTED** (and, per §2.4, unreachable from a content script
  anyway).

### What to paste back (per site)

From the panel: **Summary → console** (one `SUMMARY` json), then the
`BLOCKED` / `RESUME` / `RESULT` / `THREAD` lines for steps 6–9, the
`KEYDOWN` lines for steps 2–4, and every `BYPASS` line from step 10
with the element you clicked written next to it. Drop them under a
`### Live run — <date>` heading in the matching §3 section. Only the
synthetic marker should appear anywhere in those lines.

---

## Appendix A — harness results (local fixtures, 54 runs)

Baseline = no arm, real Enter / real Send-click → must send.
`sitePD` = site's handler called `preventDefault` (seen at window-bubble;
true for Enter on all three, false for click — sites don't prevent a
button click's default). `NET` = send-like requests observed for the
run (canonical `NET` count; the first pass double-counted because the
MAIN-world raw line shared the prefix — since renamed `NET-MAIN`).

| fixture           | guard     | test         | trigger     | result                                                                                   |
| ----------------- | --------- | ------------ | ----------- | ---------------------------------------------------------------------------------------- |
| react-prosemirror | none      | baseline     | enter       | sent ✓ · capture isTrusted:true · sitePD:true                                            |
| react-prosemirror | none      | baseline     | click       | sent ✓ · capture isTrusted:true · sitePD:false                                           |
| react-prosemirror | none      | double-enter | —           | 2 keydowns → 1 turn                                                                      |
| react-prosemirror | none      | resume c     | enter/click | BLOCKED-AS-EXPECTED ×2 · marker still in composer                                        |
| react-prosemirror | none      | resume a     | enter/click | **SUBMITTED** ×2 via marker-in-thread · synthetic isTrusted:false · buttonDisabled:false |
| react-prosemirror | none      | resume b     | enter/click | **SUBMITTED** ×2 via marker-in-thread · synthetic isTrusted:false                        |
| react-prosemirror | isTrusted | baseline     | enter/click | sent ✓ (trusted events pass the guard)                                                   |
| react-prosemirror | isTrusted | resume a     | enter/click | **NO-OP** ×2 · marker still in composer · guard rejection logged                         |
| react-prosemirror | isTrusted | resume b     | enter/click | **NO-OP** ×2 · marker still in composer · guard rejection logged                         |
| react-textarea    | none      | baseline     | enter/click | sent ✓ · sitePD true/false                                                               |
| react-textarea    | none      | double-enter | —           | 2 keydowns → 1 turn                                                                      |
| react-textarea    | none      | resume c/a/b | enter/click | BLOCKED ×2 · **SUBMITTED** ×2 · **SUBMITTED** ×2                                         |
| react-textarea    | isTrusted | resume a/b   | enter/click | **NO-OP** ×4 · guard rejection logged                                                    |
| angular-shaped    | none      | baseline     | enter/click | sent ✓ · sitePD true/false                                                               |
| angular-shaped    | none      | double-enter | —           | 2 keydowns → 1 turn                                                                      |
| angular-shaped    | none      | resume c/a/b | enter/click | BLOCKED ×2 · **SUBMITTED** ×2 · **SUBMITTED** ×2                                         |
| angular-shaped    | isTrusted | resume a/b   | enter/click | **NO-OP** ×4 · guard rejection logged                                                    |

Raw NDJSON: the harness writes `out/harness-results.json`; the fixture
sources, `build.mjs`, `harness.mjs`, and the localhost-patched
extension copy are spike scratch (not committed) and are reproducible
from the description in §1.2.

## Appendix B — log line reference

| Line                                                                       | World           | Meaning                                                                                                                          |
| -------------------------------------------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `INSTALL-EARLY`                                                            | isolated        | listeners registered at `document_start`                                                                                         |
| `DISCOVERY`                                                                | isolated        | composer + Send button resolved; `composerInShadow`                                                                              |
| `KEYDOWN`                                                                  | isolated        | window-capture Enter: `isTrusted`, `isComposing`, `keyCode`, modifiers, `defaultPrevented:false`, content-free composer snapshot |
| `KEYDOWN-BUBBLE`                                                           | isolated        | window-bubble: `defaultPrevented` now true ⇒ site handler ran after us (Q2)                                                      |
| `COMPOSER-AFTER-RAF`                                                       | isolated        | composer `len`/`hash` one frame later (Q3 rerender check)                                                                        |
| `COMPOSITIONEND`                                                           | isolated        | IME confirmation landed (Q4)                                                                                                     |
| `CLICK` / `CLICK-BUBBLE` / `POINTERDOWN`                                   | isolated        | button clicks; `onSendButton`, `detail` (double-click), `synthetic:'ours'` on our resume click                                   |
| `REACT-ROOT`                                                               | MAIN            | React container above the target (invisible from isolated world)                                                                 |
| `NET-MAIN` / `NET`                                                         | MAIN / isolated | raw / canonical request line: method + pathname only; `attributedTo: user-send \| resume \| BYPASS?`                             |
| `BYPASS`                                                                   | isolated        | send-like request with no Enter/Send-click in prior 3 s (Q7)                                                                     |
| `ARMED` / `BLOCKED` / `RESUME` / `RESUME-DISPATCHED` / `RESULT` / `THREAD` | isolated        | the resume test; `RESULT verdict ∈ SUBMITTED \| NO-OP \| BLOCKED-AS-EXPECTED`                                                    |
| `SUMMARY`                                                                  | isolated        | roll-up for pasting back                                                                                                         |
