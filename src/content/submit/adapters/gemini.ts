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
//   • send button: `gem-icon-button.send-button button` — CONFIRMED the
//     ONLY match (exactly 1) once the composer has text, and it IS the
//     same element as `button[aria-label="Send message"]`. It is a
//     Material icon button (class includes `mdc-icon-button
//     mat-mdc-icon-button`); there is NO `data-testid` on the `<button>`.
//     Absent / non-matching while the composer is empty, so it is
//     resolved at resume time only. While generating, Gemini swaps to a
//     Stop control (a different control, not `gem-icon-button.send-button`),
//     so this selector won't collide; the base's `isButtonUsable` covers
//     the disabled case.
//
// LOCALE INDEPENDENCE (gap CLOSED, confirmed live 5 Sep 2026): the
// send `<button>`'s parent is a custom element
// `<gem-icon-button class="send-button … submit">`. The `send-button`
// and `submit` classes live on that WRAPPER, not on the `<button>` —
// which is why an earlier `button.send-button` guess matched 0. The
// PRIMARY selector now keys on that wrapper class
// (`gem-icon-button.send-button button`), a locale-INDEPENDENT handle
// that does not depend on the English `aria-label`, so a *button-click*
// send is intercepted in EVERY locale. `button[aria-label="Send
// message"]` is kept only as an English fallback in the comma selector
// (harmless — resolves the same node). A more generic locale-independent
// alternative, `button:has(mat-icon[data-mat-icon-name="arrow_upward"])`,
// is documented but NOT used as primary (broader, could drift onto other
// arrow-icon buttons). Enter-to-send was already locale-safe in every
// build — it keys off the COMPOSER, not the button, and the resume path
// falls back to a re-dispatched Enter when the button can't be resolved.
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
  sendButtonSelector: 'gem-icon-button.send-button button, button[aria-label="Send message"]',
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
