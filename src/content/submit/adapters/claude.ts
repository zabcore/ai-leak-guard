// V1.3 M3 — Claude (claude.ai) submit-scan adapter. All behaviour is
// in `BaseSubmitAdapter`; this is the site config only.
//
// GROUND TRUTH from the M0 live run on claude.ai (verified): an
// UNTRUSTED `sendButton.click()` submits — the app does not check
// `event.isTrusted`. Primary resume = `sendButton.click()` resolved
// fresh at resume time; `KeyboardEvent(Enter)` fallback. Composer is a
// ProseMirror contenteditable, same shape as ChatGPT, so the shared
// logic applies as-is.
//
// CONFIRMED SELECTORS (live, logged-in, 5 Sep 2026 — use as-is):
//   • composer:    `[contenteditable="true"][role="textbox"]`
//     (ProseMirror; matches the existing paste-flow site adapter).
//   • send button: `button[data-testid="chat-input-send"]` — the
//     `data-testid` is the primary/stable handle; `aria-label="Send
//     message"` is the SAME element as a locale-fragile fallback.
//     Verified `disabled` while the composer is empty, `disabled:false`
//     once it has text; NO Stop control matches either selector when
//     idle (Claude's stop button appears only while streaming and does
//     not match). Resolved fresh at resume time (base handles this).
//
// Q7 — programmatic send paths that bypass BOTH Enter and the send
// button (documented coverage GAPS; NOT intercepted):
//   • suggested-prompt / example chips on a new chat
//   • "Retry" on a response (incl. model switch)
//   • editing a previous message and re-sending
//   • Projects / prompt-template quick actions that submit directly

import { BaseSubmitAdapter, type SubmitAdapterOptions } from './base-submit-adapter'

const CLAUDE_CONFIG = {
  id: 'claude',
  composerSelector: '[contenteditable="true"][role="textbox"]',
  sendButtonSelector: 'button[data-testid="chat-input-send"], button[aria-label="Send message"]',
  composerKey: 'claude-composer',
} as const

export class ClaudeSubmitAdapter extends BaseSubmitAdapter {
  constructor(opts: SubmitAdapterOptions = {}) {
    super(CLAUDE_CONFIG, opts)
  }
}
