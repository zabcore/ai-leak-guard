// V1.3 M2/M3 — ChatGPT submit-scan adapter. All behaviour lives in
// `BaseSubmitAdapter`; this file is just the site config. See the base
// for the interception / IME-guard / resume / post-check logic.
//
// GROUND TRUTH from the M0 live run on chatgpt.com (verified):
//   • Resume works: an UNTRUSTED `sendButton.click()` submits — the app
//     does not check `event.isTrusted`. Primary resume =
//     `sendButton.click()`, resolved fresh at resume time.
//   • Composer is a ProseMirror contenteditable (`#prompt-textarea`,
//     `role="textbox"`); Enter is a ProseMirror keymap binding.
//
// CONFIRMED SELECTORS (live):
//   • composer:    `#prompt-textarea` / `[contenteditable][role=textbox]`
//   • send button: `button[data-testid="send-button"]`
//     (`#composer-submit-button` on some builds; `aria-label="Send
//     prompt"` as a locale-fragile fallback). Enabled only once the
//     composer has text; swaps to a Stop button (`stop-button`) while
//     streaming, which the selector deliberately does NOT match.
//
// Q7 — programmatic send paths that bypass BOTH Enter and the send
// button (documented coverage GAPS; NOT intercepted, must not be
// implied as covered):
//   • suggested-prompt chips on a new chat / under a response
//   • "Regenerate" / "Try again" on a response
//   • editing a previous user message and re-sending
//   • Voice / advanced voice mode auto-submit
//   • "Continue generating"

import { BaseSubmitAdapter, type SubmitAdapterOptions } from './base-submit-adapter'

const CHATGPT_CONFIG = {
  id: 'chatgpt',
  // V1.3.3: `textarea#mobile-composer-prompt` / `textarea[name="prompt"]` are
  // the logged-out form composer (RELEASE BLOCKER — the composer renamed and
  // moved to a plain <form> with no contenteditable).
  composerSelector:
    '#prompt-textarea, [contenteditable="true"][role="textbox"], textarea[data-testid="prompt-textarea"], textarea[name="prompt-textarea"], textarea#mobile-composer-prompt, textarea[name="prompt"]',
  // `button[aria-label="Send message"]` is the logged-out form's type=submit
  // send button; the others are the logged-in build.
  sendButtonSelector:
    'button[data-testid="send-button"], #composer-submit-button, button[aria-label="Send prompt"], button[aria-label="Send message"]',
  composerKey: 'chatgpt-composer',
  // The logged-out composer sends via form submission — intercept the form's
  // `submit` event too (in addition to Enter + the button click).
  interceptFormSubmit: true,
} as const

export class ChatGptSubmitAdapter extends BaseSubmitAdapter {
  constructor(opts: SubmitAdapterOptions = {}) {
    super(CHATGPT_CONFIG, opts)
  }
}
