// V1.3.1 — Copilot "Protection at Send", NO-RESUME design.
//
// The three shipped adapters (ChatGPT/Claude/Gemini) intercept the send,
// scan, and then RESUME it programmatically (`sendButton.click()` /
// re-dispatched Enter) because those sites act on an untrusted click.
// Copilot does NOT: an untrusted `sendButton.click()` on
// `copilot.cloud.microsoft` triggers a "Verify you are human" CAPTCHA and
// does not submit (live-confirmed). So this adapter NEVER resumes and has
// NO programmatic-send seam at all — structurally it cannot auto-send,
// exactly like the self-test runner.
//
// The whole intent handler is SYNCHRONOUS (no async, no watchdog): the
// only way a message goes out is the user's OWN trusted Enter / Send
// click. On a flagged message we merely BLOCK that native send and open
// the warning modal; "Proceed" records an in-memory acknowledgement and
// tells the user to press Send AGAIN. Their next trusted send matches the
// ack and passes through untouched (no CAPTCHA).
//
//   clean / fail-open / acked  → do NOTHING (native trusted send proceeds)
//   flagged & unacked          → preventDefault + modal; proceed = ack + refocus (no send)
//
// Privacy/safety: in-memory ack only (risk fingerprint, content-free),
// scoped to (tab, composer), cleared when the composer empties; nothing
// persisted. Metadata-only logging. IME + Shift+Enter never intercepted.
// Fail-open on scan throw / oversize.

import { stripHtmlToText } from '../../clipboard-text'
import { isDocumentModalOpen } from '../../document-modal'
import { isPreviewModalOpen } from '../../preview-modal'
import { detectDetailed, isMaskable } from '../../../detector/engine'
import type { DetectorCategory } from '../../../detector/types'
import { appendEvent, type AlgAction, type AlgEvent } from '../../../shared/event-log'
import { fingerprintFindings, type RiskFingerprint } from '../fingerprint'
import { openSubmitDecision } from '../submit-ui'
import type { DecisionSummary } from '../submit-core'

/** The Lexical contenteditable composer + the Fluent Send button. */
const COMPOSER_SELECTOR =
  '#m365-chat-editor-target-element, [contenteditable="true"][role="textbox"]'
const SEND_BUTTON_SELECTOR = 'button[aria-label="Send"]'
const COMPOSER_KEY = 'copilot-composer'

/**
 * Cap on the composer text we will scan INLINE on the send path. The
 * scan is synchronous (it blocks the user's keystroke), so an enormous
 * paste must not freeze the tab — over the cap we FAIL OPEN (native send
 * proceeds, gap logged) rather than block on a long scan.
 */
export const MAX_SYNC_SCAN_CHARS = 20000

/** Result shape of the inline scan (a subset of `detectDetailed`). */
type ScanResult = {
  findings: ReturnType<typeof detectDetailed>['findings']
  hasCriticalOrHigh: boolean
}

export interface CopilotNoResumeOptions {
  readonly isMasterEnabled?: () => boolean
  readonly isFlagEnabled?: () => boolean
  /** Metadata-only event sink; defaults to the real append. */
  readonly logEvent?: (event: AlgEvent) => void
  /**
   * Detection seam. Defaults to the real inline `detectDetailed` (the
   * production path scans synchronously on the send). Injectable ONLY so
   * a test can force a throw to exercise the fail-open branch.
   */
  readonly scan?: (text: string) => ScanResult
}

export class CopilotNoResumeAdapter {
  readonly id = 'copilot'

  private readonly isMasterEnabled: () => boolean
  private readonly isFlagEnabled: () => boolean
  private readonly logEvent: (event: AlgEvent) => void
  private readonly scan: (text: string) => ScanResult

  /**
   * Risk fingerprints the user waved through for the message CURRENTLY in
   * the composer. In-memory only, never persisted. Cleared when the
   * composer empties (the message actually went out) so the next message
   * re-warns even at the same risk shape.
   */
  private readonly acked = new Set<RiskFingerprint>()

  private observedComposer: HTMLElement | null = null
  private observer: MutationObserver | null = null

  constructor(opts: CopilotNoResumeOptions = {}) {
    this.isMasterEnabled = opts.isMasterEnabled ?? (() => true)
    this.isFlagEnabled = opts.isFlagEnabled ?? (() => true)
    this.logEvent =
      opts.logEvent ??
      ((event) => {
        try {
          void appendEvent(event)
        } catch {
          // best-effort; never into the flow
        }
      })
    this.scan = opts.scan ?? ((text) => detectDetailed(text))
  }

  attach(): void {
    window.addEventListener('keydown', this.onKeydown, true)
    window.addEventListener('click', this.onClick, true)
  }

  /** Test-only: undo `attach` so a jsdom test doesn't leak listeners. */
  detach(): void {
    window.removeEventListener('keydown', this.onKeydown, true)
    window.removeEventListener('click', this.onClick, true)
    this.observer?.disconnect()
    this.observer = null
    this.observedComposer = null
    this.acked.clear()
  }

  // ── gate ──

  private shouldConsider(): boolean {
    if (!this.isFlagEnabled()) return false
    if (!this.isMasterEnabled()) return false
    // While our own warning modal is on screen, let it own the keys.
    if (isDocumentModalOpen() || isPreviewModalOpen()) return false
    return true
  }

  // ── listeners ──

  private readonly onKeydown = (event: KeyboardEvent): void => {
    if (event.key !== 'Enter') return
    if (!this.shouldConsider()) return
    if (event.shiftKey) return
    // IME double-guard (CJK): never intercept a composition Enter.
    if (event.isComposing || event.keyCode === 229) return
    const composer = this.resolveComposer()
    if (composer === null) return
    if (!eventTargetsComposer(event, composer)) return
    this.handleIntent(event, composer)
  }

  private readonly onClick = (event: MouseEvent): void => {
    if (!this.shouldConsider()) return
    const button = sendButtonInPath(event)
    if (button === null) return
    if (!isButtonUsable(button)) return
    const composer = this.resolveComposer()
    if (composer === null) return
    this.handleIntent(event, composer)
  }

  // ── the (fully synchronous) intent handler ──

  private handleIntent(event: Event, composer: HTMLElement): void {
    this.ensureObserver(composer)

    const text = this.readComposerText(composer)

    // Oversize → fail open: don't freeze the tab on a giant inline scan.
    if (text.length > MAX_SYNC_SCAN_CHARS) {
      this.log('unable-to-inspect', null)
      return // native trusted send proceeds
    }

    let scan: ScanResult
    try {
      scan = this.scan(text)
    } catch {
      // Scan threw → fail open, record the gap.
      this.log('unable-to-inspect', null)
      return // native trusted send proceeds
    }

    if (!scan.hasCriticalOrHigh) {
      // Clean → the user's trusted send proceeds natively; no modal.
      this.log('auto-cleared', scan)
      return
    }

    const fingerprint = fingerprintFindings(scan.findings)
    if (this.acked.has(fingerprint)) {
      // The user already OK'd this exact risk shape for THIS message and
      // is pressing Send again → let the TRUSTED native send through
      // (no preventDefault → no CAPTCHA). Logged once, at proceed.
      return
    }

    // Flagged & unacknowledged → BLOCK the native send and warn. This is
    // the only branch that touches the event; there is no send seam.
    event.preventDefault()
    event.stopImmediatePropagation()
    event.stopPropagation()

    const summary = this.summarise(fingerprint, scan)
    void openSubmitDecision(summary, composer, {
      // Copilot cannot be resumed — the user must press Send themselves.
      primaryLabel: 'Proceed — press Send again',
      cancelLabel: 'Return to editing',
    })
      .then((decision) => {
        if (decision === 'proceed') {
          // Acknowledge the risk shape; the user's NEXT trusted Send now
          // matches and passes through. We do NOT send anything here.
          this.acked.add(fingerprint)
          this.log('as-is', scan)
          try {
            composer.focus?.()
          } catch {
            // focus is best-effort
          }
        } else {
          this.log('cancelled', scan)
        }
      })
      .catch(() => {
        // The modal never rejects, but a throw here must not wedge the page.
      })
  }

  // ── helpers ──

  private resolveComposer(): HTMLElement | null {
    const active = document.activeElement
    if (active instanceof HTMLElement && active.matches(COMPOSER_SELECTOR)) return active
    return document.querySelector<HTMLElement>(COMPOSER_SELECTOR)
  }

  private readComposerText(el: HTMLElement): string {
    const value = (el as HTMLTextAreaElement).value
    if (typeof value === 'string' && el.tagName === 'TEXTAREA') return value
    return stripHtmlToText(el.innerHTML)
  }

  /**
   * (Re)attach a MutationObserver to the live composer that clears the
   * acknowledgement set the moment the composer empties — i.e. the
   * message actually went out — so the next message re-warns. This is
   * NOT part of the synchronous send path and dispatches nothing.
   */
  private ensureObserver(composer: HTMLElement): void {
    if (this.observedComposer === composer && this.observer !== null) return
    this.observer?.disconnect()
    if (typeof MutationObserver !== 'function') {
      this.observedComposer = composer
      this.observer = null
      return
    }
    this.observer = new MutationObserver(() => {
      if ((composer.textContent ?? '').trim().length === 0) this.acked.clear()
    })
    this.observer.observe(composer, { childList: true, subtree: true, characterData: true })
    this.observedComposer = composer
  }

  private summarise(fingerprint: RiskFingerprint, scan: ScanResult): DecisionSummary {
    const maskable = scan.findings.filter(isMaskable)
    const categories = new Set<DetectorCategory>()
    for (const f of maskable) if (f.category) categories.add(f.category)
    return {
      composerKey: COMPOSER_KEY,
      fingerprint,
      count: maskable.length,
      categories: [...categories],
      hadCriticalOrHigh: scan.hasCriticalOrHigh,
      changedSinceAcknowledged: this.acked.size > 0,
      messageHasSensitiveText: true,
    }
  }

  /** Metadata-only. Never receives composer text or matched values. */
  private log(action: AlgAction, scan: ScanResult | null): void {
    try {
      const maskable = scan ? scan.findings.filter(isMaskable) : []
      const categories = new Set<DetectorCategory>()
      for (const f of maskable) if (f.category) categories.add(f.category)
      this.logEvent({
        ts: Date.now(),
        site: 'copilot',
        eventType: 'submit',
        action,
        categories: [...categories],
        count: maskable.length,
        hadCriticalOrHigh: scan?.hasCriticalOrHigh ?? false,
      })
    } catch {
      // never let logging break the flow
    }
  }
}

// ─── free helpers (no state) ───

function isButtonUsable(button: HTMLElement): boolean {
  if ((button as HTMLButtonElement).disabled) return false
  if (button.getAttribute('aria-disabled') === 'true') return false
  return true
}

function eventTargetsComposer(event: Event, composer: HTMLElement): boolean {
  const path = typeof event.composedPath === 'function' ? event.composedPath() : []
  if (path.includes(composer)) return true
  const target = event.target
  return target instanceof Node && (target === composer || composer.contains(target))
}

function sendButtonInPath(event: Event): HTMLElement | null {
  const path = typeof event.composedPath === 'function' ? event.composedPath() : []
  for (const node of path) {
    if (node instanceof Element && node.matches(SEND_BUTTON_SELECTOR)) return node as HTMLElement
  }
  return null
}
