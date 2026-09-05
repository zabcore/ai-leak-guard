// V1.3 M3 — Gemini (gemini.google.com) submit-scan adapter. All
// behaviour is in `BaseSubmitAdapter`; this is the site config only.
//
// GROUND TRUTH from the M0 live run on gemini.google.com (verified):
// an UNTRUSTED `sendButton.click()` submits — the app does not check
// `event.isTrusted`. Primary resume = `sendButton.click()` resolved
// fresh at resume time; `KeyboardEvent(Enter)` fallback. Gemini is an
// Angular app; capture-phase on `window` still fires before Angular's
// handlers (same as React). Angular Material inputs still emit
// `isComposing` / `keyCode 229`, so the base IME double-guard covers
// CJK entry.
//
// CONFIRMED SELECTORS (live, logged-in, 5 Sep 2026 — use as-is):
//   • composer: `rich-textarea [contenteditable="true"]`. The composer
//     is a contenteditable INSIDE the `<rich-textarea>` custom element
//     (light DOM, per the A0 spike). `matchesComposer` below also
//     resolves the `<rich-textarea>` host / anything inside it, so the
//     composed-path walk still finds the composer even if the
//     custom-element boundary hides the inner contenteditable from a
//     naive `.matches`.
//   • send button: `button[aria-label="Send message"]` — CONFIRMED the
//     ONLY match (exactly 1) once the composer has text. It is a
//     Material icon button (class includes `mdc-icon-button
//     mat-mdc-icon-button`); there is NO `data-testid` and NO
//     `button.send-button` (that selector matched 0 — do NOT use it).
//     Absent / non-matching while the composer is empty, so it is
//     resolved at resume time only. While generating, Gemini swaps to a
//     Stop control with a DIFFERENT `aria-label`, so this selector
//     won't collide; the base's `isButtonUsable` covers the disabled
//     case.
//
// KNOWN LIMITATION (locale): the send-button selector keys on the
// ENGLISH `aria-label`, and Gemini exposes no `data-testid` / stable
// locale-independent handle for it. On a non-English Gemini UI a
// *button-click* send is therefore NOT intercepted (the label won't
// match, so `sendButtonInPath` returns null). Enter-to-send stays
// protected in every locale — it keys off the COMPOSER, not the
// button, and the resume path falls back to a re-dispatched Enter when
// the button can't be resolved. A confirmed locale-independent send
// handle is a pre-ship requirement (owner live-audit); we do NOT guess
// one here, because a broader Material-icon-button selector would
// mis-target unrelated icon buttons (attach, mic, …) and intercept
// clicks that are not sends.
//
// Q7 — programmatic send paths that bypass BOTH Enter and the send
// button (documented coverage GAPS; NOT intercepted):
//   • suggestion chips (new chat and under a response)
//   • "regenerate" / "modify response" / show-more-drafts actions
//   • Gemini Live / voice auto-submit
//   • Deep Research "Start research" and canvas quick actions
//   • editing a previous prompt and re-sending

import { BaseSubmitAdapter, type SubmitAdapterOptions } from './base-submit-adapter'

const GEMINI_CONFIG = {
  id: 'gemini',
  composerSelector: 'rich-textarea [contenteditable="true"]',
  sendButtonSelector: 'button[aria-label="Send message"]',
  composerKey: 'gemini-composer',
  // The `<rich-textarea>` custom-element boundary can keep the inner
  // contenteditable out of a naive `.matches` on a composed-path node
  // (the node may be the host, or a wrapper). Accept: the inner
  // contenteditable, or the `<rich-textarea>` host itself. The base
  // then NORMALIZES a host match down to the inner contenteditable for
  // reading + resume. `role="textbox"` is deliberately NOT a match
  // condition — only a real `contenteditable` element (or the host) is
  // the editor; a bare `role="textbox"` node could be a non-editable
  // widget.
  matchesComposer: (el: Element): boolean => {
    if (el.matches('rich-textarea [contenteditable="true"]')) return true
    if (el.matches('rich-textarea')) return true
    const host = el.closest('rich-textarea')
    if (host === null) return false
    return el.getAttribute('contenteditable') === 'true'
  },
} as const

export class GeminiSubmitAdapter extends BaseSubmitAdapter {
  constructor(opts: SubmitAdapterOptions = {}) {
    super(GEMINI_CONFIG, opts)
  }
}
