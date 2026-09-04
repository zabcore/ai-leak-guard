# ALG M0 spike — send-intercept instrumentation (THROWAWAY)

**Never publish. Never merge into the product build.** This folder is
outside `src/` and outside every product gate (`tsc` includes only
`src`/`tests`; ESLint targets `**/*.ts`; Vite reads the root
`manifest.json`). It is a plain-JS MV3 extension you load unpacked.

Findings go in `docs/SPIKE_M0_SEND_INTERCEPT.md`.

## Load it

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked**
   → pick `spike/m0-send-intercept/`.
2. **Disable the real AI Leak Guard extension** for the run so its
   window-capture paste listener and modals can't confound the trace.
3. Open the target site logged in. A small dark **ALG-M0** panel
   appears bottom-right. Open DevTools → Console, filter `[ALG-M0]`.

## The 10-minute protocol (per site)

Use the synthetic marker only: `ALGTEST Jane Doe MRN 12345678`. Never
type real content while the spike is loaded — the passive logger
records composer **length + hash**, never text, but the site's own
thread will display whatever you send.

Do the steps in order; each maps to a question in the feasibility note.

| Step | Do this                                                                                                                                                                                                                 | Answers | Look for in console                                                                                                                                                     |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Panel → **2. Find composer + send button**                                                                                                                                                                              | Q3      | `DISCOVERY` — composer + send button resolved, `composerInShadow`                                                                                                       |
| 1    | Type `abc`, press **Enter** (sends `abc` — fine)                                                                                                                                                                        | Q2, Q3  | `KEYDOWN` window-capture (isTrusted:true) → `KEYDOWN-BUBBLE` with `defaultPrevented:true` = site ran AFTER us; `REACT-ROOT` (from MAIN world) names the React container |
| 2    | Type `abc`, press **Shift+Enter** (newline, no send)                                                                                                                                                                    | Q4      | `KEYDOWN` with `shift:true`; no send-like `NET`                                                                                                                         |
| 3    | Switch OS keyboard to an IME (JP/CN/KR), type a word, press **Enter to confirm** the candidate, then Enter again to send                                                                                                | Q4      | first Enter: `isComposing:true` and/or `keyCode:229`, `COMPOSITIONEND`; second Enter: `isComposing:false`                                                               |
| 4    | Type `abc`, press **Ctrl+Enter**, then **Cmd/Win+Enter**                                                                                                                                                                | Q5      | `KEYDOWN` with `ctrl:true` / `meta:true`; did a send-like `NET` fire?                                                                                                   |
| 5    | Type `abc`, press **Enter twice fast**; then type `abc`, **double-click Send**                                                                                                                                          | Q6      | two `KEYDOWN`s / two `CLICK`s — how many send-like `NET`? one or two?                                                                                                   |
| 6    | Panel → **1. Insert MARKER** → **3c. Arm (control)** → press Enter                                                                                                                                                      | Q1 ctrl | `BLOCKED` then `RESULT verdict:BLOCKED-AS-EXPECTED`; marker still in composer, nothing in thread                                                                        |
| 7    | (marker still in composer) Panel → **3a. Arm (button.click)** → press Enter                                                                                                                                             | **Q1**  | `BLOCKED` → `RESUME mechanism:sendButton.click()` → `CLICK synthetic:'ours' isTrusted:false` → `RESULT verdict:…`                                                       |
| 8    | Panel → **1. Insert MARKER** → **3b. Arm (KeyboardEvent)** → press Enter                                                                                                                                                | **Q1**  | `BLOCKED` → `RESUME mechanism:…KeyboardEvent…` → `RESUME-DISPATCHED` → `RESULT verdict:…`                                                                               |
| 9    | Repeat 7 and 8 but trigger the send by **clicking the Send button** instead of Enter                                                                                                                                    | Q1      | same, `BLOCKED via:click`                                                                                                                                               |
| 10   | New chat. Click a **suggested-prompt chip**. Then **Regenerate/Retry** a response. Then **edit a sent message** and resubmit. Then try **voice/dictation** if the site has it. Then **Continue generating** if offered. | **Q7**  | any `BYPASS` line = a send with no Enter/send-click before it. Note which UI element you clicked for each `BYPASS`                                                      |
| 11   | Panel → **Summary → console**, then **Copy full log** and paste it under the site's section in the feasibility note                                                                                                     | all     | `SUMMARY` json                                                                                                                                                          |

`RESULT verdict:SUBMITTED` needs the marker to appear in the
conversation thread (`THREAD` line) **or** a send-like network request
(`NET … attributedTo:'resume'`). If only `NET` fires but no `THREAD`,
open the Network tab and confirm the request actually carried the
message — a 4xx on the re-dispatch is a NO-OP in disguise.

## What "actually submits" means

The `THREAD` watcher is a `MutationObserver` on the whole document
that fires when a node containing the marker string is added
**outside** the composer. That is the ground truth. `NET` is the
secondary signal (MAIN-world wrapper on `fetch`/XHR/`WebSocket.send`,
logging method + pathname only, never bodies). Each request produces
two console lines: `NET-MAIN` (raw, from the page realm) and `NET`
(canonical, from the content script, with `attributedTo` /
`msSinceUserSend` correlation). Count `NET`, not both.

`REACT-ROOT` is logged once per page from the MAIN world because
React's `__reactContainer$…` expando is invisible from a content
script's isolated world — a finding in its own right: nothing in a
product content script can ever locate React internals, which is
also why the brief classifies "invoke an internal framework function"
as UNSUPPORTED.

## Safety

- Passive listeners never call `preventDefault`. Only an **armed**
  resume test blocks exactly one trusted send, then disarms itself.
- The extension declares **no permissions** and **no host
  permissions** — content-script `matches` are enough for
  instrumentation.
- Nothing is written to storage or sent anywhere. The log lives in
  page memory; "Copy log" uses the clipboard on your click.
- The only literal text logged is the synthetic marker.

## Uninstall

`chrome://extensions` → Remove. Re-enable the real AI Leak Guard.
