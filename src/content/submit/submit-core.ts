// V1.3 M1 — submit-scan core state machine ("Protection at Send").
//
// Site-agnostic. No DOM, no listeners, no adapters. A site adapter
// (M2/M3) intercepts the user's send (capture-phase Enter / Send
// click), hands the core a `SendIntent`, and — per the M0 spike —
// resumes the send by re-clicking the site's own Send button when
// the core says so. This module decides *whether and when* that
// resume happens. It never touches the composer content except to
// hand it to the detector, and it never logs it.
//
// STATES
//   IDLE → HELD_SCANNING → (DECISION) → RESUMING → SUBMITTED
//                       ↘ FAILED_OPEN ↗           ↘ RETURNED_TO_EDIT
//                                                  ↘ ADAPTER_DISABLED
//
// THE INVARIANT THAT OUTRANKS EVERYTHING
//   No timer and no failure path may ever auto-SUBMIT content that a
//   scan has flagged. Fail-open (auto-proceed) is a property of the
//   *automated* phases only — composer read + detection, guarded by
//   Watchdog-A. Once a scan flags content the send is gated on an
//   explicit user choice. The DECISION phase deliberately has NO
//   auto-send timer; its only permitted liveness default is
//   RETURNED_TO_EDIT (cancel the send, keep the draft), and that
//   guard is OFF by default. A throw inside the decision UI also
//   lands on RETURNED_TO_EDIT, never on a submit.
//
// TWO WATCHDOGS, TWO DEFAULTS
//   Watchdog-A (scan)     — armed on HELD_SCANNING; expiry or any
//                           throw → FAILED_OPEN → resume the send and
//                           log a metadata-only `unable-to-inspect`
//                           ("incomplete protection") event. Default
//                           = PROCEED. Budget `SCAN_WATCHDOG_MS`.
//   DECISION liveness     — OFF (`DECISION_LIVENESS_MS = null`). If a
//                           deployment ever enables it, its only
//                           outcome is RETURNED_TO_EDIT.
//
// RE-ENTRANCY
//   At most one in-flight send per (tab, composer). A second intent
//   arriving while HELD/DECISION/RESUMING is coalesced onto the
//   in-flight promise — never a second submission. The resume
//   closure is idempotent: it invokes the adapter at most once.
//
// DEDUP
//   The detection result is fingerprinted (category → count, see
//   `fingerprint.ts`) in memory, scoped to (tab, composer). A
//   fingerprint the user has already acknowledged with "proceed"
//   skips the modal WHILE THE SAME MESSAGE IS STILL UNSENT (a repeat
//   Enter, a no-op edit, or a swallowed-resume retry). The moment a
//   message actually sends, the acknowledgement set for that composer
//   is cleared, so the NEXT message re-warns even at the same risk
//   shape — a second patient's PHI is a new disclosure, not a
//   duplicate. Any change in category or count re-warns immediately.
//   Fingerprints are NEVER persisted — release blocker, test-pinned.
//
// KILL SWITCH
//   `adapter.resume()` returning `'failed'` (after the optional
//   fallback) increments a per-adapter counter; at
//   `RESUME_FAILURE_KILL_THRESHOLD` the adapter is disabled for the
//   session: `handleSendIntent` returns `handled: false` so the
//   adapter must stop intercepting and the site's native send works
//   again, and the popup is told via `reportAdapterDisabled`. A user
//   is never left silently unable to send.
//
// FLAG
//   `isSubmitProtectionEnabled()` (default OFF). With the flag off the
//   core returns `handled: false` immediately. M1 wires nothing into
//   the live content script.

import { detectDetailed, isMaskable } from '../../detector/engine'
import type { DetectorCategory, Finding } from '../../detector/types'
import { appendEvent, type AlgAction, type AlgEvent } from '../../shared/event-log'
import { setSubmitKillSwitch } from '../../shared/storage'
import { isSubmitProtectionEnabled } from './submit-flag'
import { fingerprintFindings, EMPTY_FINGERPRINT, type RiskFingerprint } from './fingerprint'
import {
  getDoc as getDocDefault,
  whenDocSettled as whenDocSettledDefault,
  markDocAcknowledged as markDocAcknowledgedDefault,
  clearDoc as clearDocDefault,
  type DocGateSnapshot,
} from './document-gate'

// ─── tunables ───────────────────────────────────────────────────────

/**
 * Watchdog-A budget: composer read + detection + any pending-file
 * wait. Initial value; tune per site once M2 has real numbers. On
 * expiry the send PROCEEDS (fail-open) and an `unable-to-inspect`
 * event is logged.
 */
export const SCAN_WATCHDOG_MS = 250

/**
 * DECISION-phase liveness guard. `null` = no guard: the send stays
 * held until the user chooses. If ever set, expiry yields
 * RETURNED_TO_EDIT — never a submit.
 */
export const DECISION_LIVENESS_MS: number | null = null

/**
 * V1.3 M4 — how long the send waits on a still-running attach-time file
 * inspection (the document gate reports `pending`). Chosen with A-4
 * (cap+watchdog together): the attach-time inspection has its own
 * per-file extraction timeout, so this bound only bites when the user
 * sends WHILE a file is mid-inspection. On expiry the FILE dimension
 * fails open — the send proceeds and an `unable-to-inspect` gap is
 * logged (automated-phase default, A-1). It NEVER auto-sends content a
 * TEXT scan flagged: flagged text always reaches a user decision
 * regardless of a hung file.
 */
export const DOC_WAIT_WATCHDOG_MS = 3000

/** Consecutive `'failed'` resumes per adapter before the session kill switch engages. */
export const RESUME_FAILURE_KILL_THRESHOLD = 3

// ─── types ──────────────────────────────────────────────────────────

export type SubmitState =
  | 'IDLE'
  | 'HELD_SCANNING'
  | 'DECISION'
  | 'RESUMING'
  | 'FAILED_OPEN'
  | 'SUBMITTED'
  | 'RETURNED_TO_EDIT'
  | 'ADAPTER_DISABLED'

export type SubmitTerminalState = 'SUBMITTED' | 'RETURNED_TO_EDIT' | 'ADAPTER_DISABLED'

export type ResumeResult = 'submitted' | 'unknown' | 'failed'

export type UserDecision = 'proceed' | 'return-to-edit'

/**
 * Site adapter contract. Defined in M1; NOT implemented for any real
 * site here. `attach` is where M2 wires capture-phase Enter + Send
 * click and calls `core.handleSendIntent`.
 */
export interface SubmitAdapter {
  readonly id: string
  attach(core: SubmitCore): void
  readComposerText(): string
  resume(): ResumeResult
}

export interface SendIntent {
  /** Stable key for the composer element (adapter-chosen). */
  readonly composerKey: string
  /** Optional tab/frame discriminator; defaults to a single tab scope. */
  readonly tabKey?: string
}

export interface ScanOutcome {
  readonly findings: readonly Finding[]
  readonly hasCriticalOrHigh: boolean
}

/**
 * V1.3 M4 — the attached-file dimension of a combined send decision.
 * Metadata only (category enums + a count + flags), NEVER file content
 * or filenames. Present on a `DecisionSummary` only when an attached
 * file needs a decision at send (detected-unacked or unable-to-inspect).
 */
export interface DecisionFileSummary {
  /** 'detected' → sensitive content found; 'unable-to-inspect' → we couldn't read it. */
  readonly status: 'detected' | 'unable-to-inspect'
  /** Attached files in this inspection (≥1). Drives "…and its attachment(s)". */
  readonly fileCount: number
  readonly categories: readonly DetectorCategory[]
  readonly count: number
  readonly hasCriticalOrHigh: boolean
}

/** What the decision UI (M2) receives. Metadata only — no text, no matched values. */
export interface DecisionSummary {
  readonly composerKey: string
  readonly fingerprint: RiskFingerprint
  readonly count: number
  readonly categories: readonly DetectorCategory[]
  readonly hadCriticalOrHigh: boolean
  /** True when this composer had a *different* acknowledged fingerprint before — the risk picture changed. */
  readonly changedSinceAcknowledged: boolean
  /** True when the typed message itself carried flagged text (vs a file-only send decision). */
  readonly messageHasSensitiveText: boolean
  /**
   * V1.3 M4 — present when an attached file also needs a decision at
   * send. The SAME modal governs both dimensions (blocker §10.6: one
   * combined modal, never two in sequence for one send).
   */
  readonly file?: DecisionFileSummary
}

export type SubmitRoute =
  | 'flag-off'
  | 'adapter-disabled'
  | 'clean'
  | 'dedup-skip'
  | 'proceed'
  | 'return-to-edit'
  | 'liveness-cancel'
  | 'decision-error'
  | 'failed-open'

export interface SubmitOutcome {
  /** False when the core did not take the send (flag off / adapter disabled): the adapter must let the native send through. */
  readonly handled: boolean
  readonly state: SubmitTerminalState | 'IDLE'
  readonly route: SubmitRoute
  /** Watchdog-A expiry or a throw in an automated phase → proceeded without a complete scan. */
  readonly failedOpen: boolean
  readonly submitted: boolean
  readonly resumeResult: ResumeResult | null
  /** Additional intents coalesced onto this in-flight send. */
  readonly coalescedIntents: number
}

export interface SubmitCoreDeps {
  /** Detection seam. Default: `detectDetailed`. May be async (pending-file wait). */
  readonly scan: (text: string) => ScanOutcome | Promise<ScanOutcome>
  /**
   * Decision UI seam (M2 modal). Resolves only on an explicit user
   * choice. M1 default has no UI and resolves `'return-to-edit'` —
   * flagged content is never auto-sent.
   */
  readonly decide: (summary: DecisionSummary) => Promise<UserDecision>
  /** Optional second resume mechanism tried when `adapter.resume()` fails (e.g. KeyboardEvent re-dispatch). */
  readonly fallbackResume?: (adapter: SubmitAdapter) => ResumeResult
  readonly setTimer: (fn: () => void, ms: number) => number
  readonly clearTimer: (id: number) => void
  readonly scanWatchdogMs: number
  readonly decisionLivenessMs: number | null
  readonly killThreshold: number
  // ── V1.3 M4: document coordination gate seams (default to the real
  //    in-memory `document-gate` module; tests inject fakes). ──
  /** Snapshot the attached-file state for a composer at send. */
  readonly getDoc: (composerKey: string) => DocGateSnapshot
  /** Resolve when the file state leaves 'pending' (bounded by the watchdog). */
  readonly whenDocSettled: (
    composerKey: string,
    signal?: { aborted: boolean },
  ) => Promise<DocGateSnapshot>
  /** Mark the composer's attachment acknowledged (dedup within one unsent message). */
  readonly markDocAcknowledged: (composerKey: string) => void
  /** Drop the composer's attachment state on a confirmed send. */
  readonly clearDoc: (composerKey: string) => void
  /** Budget for waiting on a pending attach-time inspection at send. */
  readonly docWaitWatchdogMs: number
  /** Site label for the metadata event log; `''` skips logging. */
  readonly logSiteId: string
  readonly logEvent: (event: AlgEvent) => void
  readonly reportAdapterDisabled: (adapterId: string) => void
  readonly isEnabled: () => boolean
  readonly onTransition?: (composerKey: string, from: SubmitState, to: SubmitState) => void
}

// ─── defaults ───────────────────────────────────────────────────────

const defaultDeps: SubmitCoreDeps = {
  scan: (text) => {
    const { findings, hasCriticalOrHigh } = detectDetailed(text)
    return { findings, hasCriticalOrHigh }
  },
  decide: async () => {
    // M1 has no decision UI. The only safe answer for flagged
    // content without a user in the loop is to hold the draft.
    console.warn('[AI Leak Guard] submit-core: no decision UI wired; returning to edit')
    return 'return-to-edit'
  },
  setTimer: (fn, ms) => setTimeout(fn, ms) as unknown as number,
  clearTimer: (id) => clearTimeout(id),
  scanWatchdogMs: SCAN_WATCHDOG_MS,
  decisionLivenessMs: DECISION_LIVENESS_MS,
  killThreshold: RESUME_FAILURE_KILL_THRESHOLD,
  getDoc: getDocDefault,
  whenDocSettled: whenDocSettledDefault,
  markDocAcknowledged: markDocAcknowledgedDefault,
  clearDoc: clearDocDefault,
  docWaitWatchdogMs: DOC_WAIT_WATCHDOG_MS,
  logSiteId: '',
  logEvent: (event) => {
    try {
      void appendEvent(event)
    } catch {
      // Best-effort; never into the flow.
    }
  },
  reportAdapterDisabled: (adapterId) => {
    try {
      void setSubmitKillSwitch({ adapterId, ts: Date.now() })
    } catch {
      // Best-effort.
    }
  },
  isEnabled: isSubmitProtectionEnabled,
}

class WatchdogExpired extends Error {
  constructor(ms: number) {
    super(`[AI Leak Guard] submit-core: scan watchdog expired after ${ms} ms`)
  }
}

/**
 * Build the idempotent resume closure. Calls `adapter.resume()` at
 * most once (plus at most one fallback attempt); every later call
 * returns the cached result. Exported so the idempotency contract
 * can be unit-tested directly.
 */
export function createIdempotentResume(
  adapter: SubmitAdapter,
  fallback?: (adapter: SubmitAdapter) => ResumeResult,
): () => ResumeResult {
  let done = false
  let result: ResumeResult = 'failed'
  return () => {
    if (done) return result
    done = true
    try {
      result = adapter.resume()
    } catch {
      result = 'failed'
    }
    if (result === 'failed' && fallback) {
      try {
        result = fallback(adapter)
      } catch {
        result = 'failed'
      }
    }
    return result
  }
}

// ─── core ───────────────────────────────────────────────────────────

interface InFlight {
  promise: Promise<SubmitOutcome>
  coalesced: number
}

export class SubmitCore {
  private readonly deps: SubmitCoreDeps
  private readonly inFlight = new Map<string, InFlight>()
  private readonly states = new Map<string, SubmitState>()
  /**
   * Fingerprints the user has waved through for the CURRENTLY-UNSENT
   * message in each composer. In-memory ONLY, never persisted.
   * Cleared for a composer as soon as one of its messages actually
   * sends (see `resumePhase`) so the next same-shape message
   * re-warns — the set exists only to avoid re-nagging within a
   * single unsent message, not across sends.
   */
  private readonly acknowledged = new Map<string, Set<RiskFingerprint>>()
  private readonly resumeFailures = new Map<string, number>()
  private readonly disabledAdapters = new Set<string>()

  constructor(deps: Partial<SubmitCoreDeps> = {}) {
    // An explicit `undefined` in `deps` means "use the default", not
    // "no dependency" — strip before spreading so a caller cannot
    // accidentally clobber a default seam with `undefined`.
    const provided = Object.fromEntries(
      Object.entries(deps).filter(([, v]) => v !== undefined),
    ) as Partial<SubmitCoreDeps>
    this.deps = { ...defaultDeps, ...provided }
  }

  getState(intent: SendIntent): SubmitState {
    return this.states.get(scopeKey(intent)) ?? 'IDLE'
  }

  isAdapterDisabled(adapterId: string): boolean {
    return this.disabledAdapters.has(adapterId)
  }

  /** Test/diagnostic: has this (tab, composer) acknowledged the given fingerprint? Never persisted. */
  hasAcknowledged(intent: SendIntent, fingerprint: RiskFingerprint): boolean {
    return this.acknowledged.get(scopeKey(intent))?.has(fingerprint) ?? false
  }

  /**
   * Entry point for adapters. Resolves with the terminal outcome.
   * Never rejects. Re-entrant calls for the same (tab, composer)
   * while a send is in flight coalesce onto the in-flight promise.
   */
  handleSendIntent(adapter: SubmitAdapter, intent: SendIntent): Promise<SubmitOutcome> {
    if (!this.deps.isEnabled()) {
      return Promise.resolve(notHandled('IDLE', 'flag-off'))
    }
    if (this.disabledAdapters.has(adapter.id)) {
      return Promise.resolve(notHandled('ADAPTER_DISABLED', 'adapter-disabled'))
    }
    const key = scopeKey(intent)
    const existing = this.inFlight.get(key)
    if (existing) {
      existing.coalesced += 1
      return existing.promise
    }
    const entry: InFlight = {
      promise: Promise.resolve(notHandled('IDLE', 'flag-off')),
      coalesced: 0,
    }
    entry.promise = this.run(adapter, intent, key, entry).finally(() => {
      this.inFlight.delete(key)
    })
    this.inFlight.set(key, entry)
    return entry.promise
  }

  // ── the state machine ──

  private async run(
    adapter: SubmitAdapter,
    intent: SendIntent,
    key: string,
    entry: InFlight,
  ): Promise<SubmitOutcome> {
    const submitOnce = createIdempotentResume(adapter, this.deps.fallbackResume)
    const finish = (
      state: SubmitTerminalState,
      route: SubmitRoute,
      failedOpen: boolean,
      resumeResult: ResumeResult | null,
    ): SubmitOutcome => ({
      handled: true,
      state,
      route,
      failedOpen,
      submitted: state === 'SUBMITTED',
      resumeResult,
      coalescedIntents: entry.coalesced,
    })

    // ── HELD_SCANNING (Watchdog-A armed) ──
    this.transition(key, 'HELD_SCANNING')
    let scan: ScanOutcome | null = null
    try {
      scan = await this.withWatchdog(() => this.scanPhase(adapter), this.deps.scanWatchdogMs)
    } catch {
      scan = null
    }

    if (scan === null) {
      // ── FAILED_OPEN: automated TEXT phase failed → proceed, log gap ──
      this.transition(key, 'FAILED_OPEN')
      this.log('unable-to-inspect', null)
      return this.resumePhase(adapter, intent.composerKey, key, submitOnce, 'failed-open', true, finish)
    }

    // ── V1.3 M4: fold in the document coordination gate ──
    // The SEND is the final orchestration point: reconcile the typed
    // TEXT (just scanned) with any attached FILE the V1.2 flow inspected
    // at attach time. A still-running inspection (`pending`) is awaited,
    // bounded by the doc-wait watchdog; on expiry the FILE dimension
    // fails open (never block the user on a hung scan — automated-phase
    // default, A-1) and the gap is recorded. This wait NEVER gates
    // flagged TEXT: flagged text always reaches a user decision below,
    // regardless of the file.
    let doc = this.deps.getDoc(intent.composerKey)
    let fileFailedOpen = false
    if (doc.status === 'pending') {
      const signal = { aborted: false }
      try {
        doc = await this.withWatchdog(
          () => this.deps.whenDocSettled(intent.composerKey, signal),
          this.deps.docWaitWatchdogMs,
        )
      } catch {
        signal.aborted = true
        fileFailedOpen = true
      }
    }

    // TEXT dimension. The acknowledged set only holds fingerprints for
    // the composer's current unsent message (cleared on a confirmed
    // send) — a dedup here means "already OK'd this exact risk shape for
    // the message still sitting in the composer" (repeat Enter / no-op
    // edit / swallowed-resume retry), never across sends.
    const textFingerprint = scan.hasCriticalOrHigh ? fingerprintFindings(scan.findings) : null
    const acked = this.acknowledged.get(key)
    const textDedupAcked = textFingerprint !== null && (acked?.has(textFingerprint) ?? false)
    const textNeedsDecision = textFingerprint !== null && !textDedupAcked

    // FILE dimension. A settled 'detected' (unacknowledged) OR any
    // 'unable-to-inspect' needs a decision — a completed "can't read it"
    // is a decision, not a pass, and is NEVER auto-safe. A 'clean' /
    // 'none' file, or an already-acknowledged 'detected' file, needs no
    // decision (dedup, §9). A watchdog fail-open is not a decision.
    const fileNeedsDecision =
      !fileFailedOpen &&
      ((doc.status === 'detected' && !doc.acknowledged) || doc.status === 'unable-to-inspect')

    // ── route: neither / one / both ──
    if (!textNeedsDecision && !fileNeedsDecision) {
      if (fileFailedOpen) {
        // The FILE automated phase timed out → fail open + record the
        // gap. (A hung file with FLAGGED text never lands here — that
        // path has `textNeedsDecision` and routes to the decision.)
        this.transition(key, 'FAILED_OPEN')
        this.log('unable-to-inspect', null)
        return this.resumePhase(adapter, intent.composerKey, key, submitOnce, 'failed-open', true, finish)
      }
      const rodeAlongAcked = textDedupAcked || (doc.status === 'detected' && doc.acknowledged)
      // Metadata-only submit row: the TEXT scan's shape. The FILE's own
      // categories/count are recorded once, at ATTACH time, as its
      // `document` event — we deliberately do NOT re-log them here, so
      // the same attachment is never counted twice (§8).
      this.log(rodeAlongAcked ? 'as-is' : 'auto-cleared', scan)
      return this.resumePhase(
        adapter,
        intent.composerKey,
        key,
        submitOnce,
        rodeAlongAcked ? 'dedup-skip' : 'clean',
        false,
        finish,
      )
    }

    // ── DECISION: at least one dimension needs the user. ONE modal,
    //    never two in sequence for one send (blocker §10.6). ──
    this.transition(key, 'DECISION')
    const summary = summariseCombined(
      intent.composerKey,
      textFingerprint,
      scan,
      (acked?.size ?? 0) > 0,
      fileNeedsDecision ? doc : null,
    )
    let decision: UserDecision
    let route: SubmitRoute
    try {
      const d = await this.decisionPhase(summary)
      decision = d.decision
      route = d.livenessFired
        ? 'liveness-cancel'
        : decision === 'proceed'
          ? 'proceed'
          : 'return-to-edit'
    } catch {
      // A broken decision UI must never turn into a send.
      decision = 'return-to-edit'
      route = 'decision-error'
    }

    if (decision !== 'proceed') {
      // Hold: submit nothing. Draft AND attachment preserved (the file
      // is still attached in the composer; we never released or cleared
      // it here). A-1 intact — the decision phase has no auto-send.
      this.transition(key, 'RETURNED_TO_EDIT')
      this.log('cancelled', scan)
      return finish('RETURNED_TO_EDIT', route, false, null)
    }

    // Acknowledge BOTH dimensions for the current unsent message so a
    // repeat Enter / swallowed-resume retry doesn't re-nag; both are
    // reset on a confirmed send so the next message re-warns.
    if (textFingerprint !== null) {
      if (!acked) this.acknowledged.set(key, new Set([textFingerprint]))
      else acked.add(textFingerprint)
    }
    if (doc.status === 'detected') this.deps.markDocAcknowledged(intent.composerKey)
    this.log('as-is', scan)
    return this.resumePhase(adapter, intent.composerKey, key, submitOnce, 'proceed', false, finish)
  }

  private async scanPhase(adapter: SubmitAdapter): Promise<ScanOutcome> {
    const text = adapter.readComposerText()
    return this.deps.scan(text)
  }

  private withWatchdog<T>(fn: () => Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false
      const id = this.deps.setTimer(() => {
        if (settled) return
        settled = true
        reject(new WatchdogExpired(ms))
      }, ms)
      Promise.resolve()
        .then(fn)
        .then(
          (v) => {
            if (settled) return
            settled = true
            this.deps.clearTimer(id)
            resolve(v)
          },
          (e) => {
            if (settled) return
            settled = true
            this.deps.clearTimer(id)
            reject(e)
          },
        )
    })
  }

  private decisionPhase(
    summary: DecisionSummary,
  ): Promise<{ decision: UserDecision; livenessFired: boolean }> {
    const liveness = this.deps.decisionLivenessMs
    if (liveness === null) {
      // No timer of any kind. Held until the user chooses.
      return this.deps.decide(summary).then((decision) => ({ decision, livenessFired: false }))
    }
    return new Promise((resolve, reject) => {
      let settled = false
      const id = this.deps.setTimer(() => {
        if (settled) return
        settled = true
        // The ONLY permitted liveness default: cancel, keep the draft.
        resolve({ decision: 'return-to-edit', livenessFired: true })
      }, liveness)
      this.deps.decide(summary).then(
        (decision) => {
          if (settled) return
          settled = true
          this.deps.clearTimer(id)
          resolve({ decision, livenessFired: false })
        },
        (e) => {
          if (settled) return
          settled = true
          this.deps.clearTimer(id)
          reject(e)
        },
      )
    })
  }

  private resumePhase(
    adapter: SubmitAdapter,
    composerKey: string,
    key: string,
    submitOnce: () => ResumeResult,
    route: SubmitRoute,
    failedOpen: boolean,
    finish: (
      state: SubmitTerminalState,
      route: SubmitRoute,
      failedOpen: boolean,
      resumeResult: ResumeResult | null,
    ) => SubmitOutcome,
  ): SubmitOutcome {
    this.transition(key, 'RESUMING')
    const result = submitOnce()
    if (result === 'submitted' || result === 'unknown') {
      // 'unknown' = the adapter could not confirm but did not fail
      // (e.g. no thread mutation observed yet). Treated as sent so we
      // never double-submit; the adapter's own observer is the
      // authority on whether to nudge the user.
      this.resumeFailures.set(adapter.id, 0)
      // A message actually went out (or the adapter treats it as
      // sent). The composer is now empty; the next Enter is a NEW
      // disclosure — possibly a different patient with the SAME risk
      // shape — so drop every acknowledged fingerprint for this
      // composer. Anything typed next re-warns. Dedup still
      // suppresses re-nag WITHIN one unsent message: a 'failed'
      // resume does NOT reach this branch (it falls through to the
      // kill-switch / RETURNED_TO_EDIT path below), so the ack it set
      // survives and the retry on the same content is still skipped.
      this.acknowledged.delete(key)
      // V1.3 M4: the message (and its attachment) actually went out —
      // drop the composer's document-gate state so the NEXT message
      // re-evaluates a fresh attachment, mirroring the text-ack reset.
      this.deps.clearDoc(composerKey)
      this.transition(key, 'SUBMITTED')
      return finish('SUBMITTED', route, failedOpen, result)
    }
    const failures = (this.resumeFailures.get(adapter.id) ?? 0) + 1
    this.resumeFailures.set(adapter.id, failures)
    if (failures >= this.deps.killThreshold) {
      this.disabledAdapters.add(adapter.id)
      try {
        this.deps.reportAdapterDisabled(adapter.id)
      } catch {
        // Best-effort.
      }
      this.transition(key, 'ADAPTER_DISABLED')
      return finish('ADAPTER_DISABLED', route, failedOpen, result)
    }
    // Below threshold: the send did not go. The draft is intact; the
    // adapter surfaces a nudge (M2). Never silent — the outcome says
    // `resumeResult: 'failed'`.
    this.transition(key, 'RETURNED_TO_EDIT')
    return finish('RETURNED_TO_EDIT', route, failedOpen, result)
  }

  // ── helpers ──

  private transition(key: string, to: SubmitState): void {
    const from = this.states.get(key) ?? 'IDLE'
    this.states.set(key, to)
    try {
      this.deps.onTransition?.(key, from, to)
    } catch {
      // Observers never break the flow.
    }
  }

  /** Metadata-only. Never receives the composer text or matched values. */
  private log(action: AlgAction, scan: ScanOutcome | null): void {
    if (this.deps.logSiteId === '') return
    try {
      const maskable = scan ? scan.findings.filter(isMaskable) : []
      const categories = new Set<DetectorCategory>()
      for (const f of maskable) if (f.category) categories.add(f.category)
      this.deps.logEvent({
        ts: Date.now(),
        site: this.deps.logSiteId,
        eventType: 'submit',
        action,
        categories: [...categories],
        count: maskable.length,
        hadCriticalOrHigh: scan?.hasCriticalOrHigh ?? false,
      })
    } catch {
      // Never let the log break the flow.
    }
  }
}

// ─── small pure helpers ─────────────────────────────────────────────

function scopeKey(intent: SendIntent): string {
  return `${intent.tabKey ?? 'tab'}::${intent.composerKey}`
}

function notHandled(state: 'IDLE' | 'ADAPTER_DISABLED', route: SubmitRoute): SubmitOutcome {
  return {
    handled: false,
    state,
    route,
    failedOpen: false,
    submitted: false,
    resumeResult: null,
    coalescedIntents: 0,
  }
}

/**
 * Build the combined decision summary (metadata only). The TEXT
 * dimension contributes only when the message itself is flagged
 * (`textFingerprint !== null`); a file-only send decision carries empty
 * text metadata and `messageHasSensitiveText: false`. The FILE
 * dimension is attached when `file` is non-null (the gate said a
 * detected/unable attachment needs a decision). The modal (`submit-ui`)
 * merges the two for display; the event log does not (§8).
 */
function summariseCombined(
  composerKey: string,
  textFingerprint: RiskFingerprint | null,
  scan: ScanOutcome,
  hadPriorAck: boolean,
  file: DocGateSnapshot | null,
): DecisionSummary {
  const maskable = textFingerprint !== null ? scan.findings.filter(isMaskable) : []
  const categories = new Set<DetectorCategory>()
  for (const f of maskable) if (f.category) categories.add(f.category)
  const base: DecisionSummary = {
    composerKey,
    fingerprint: textFingerprint ?? EMPTY_FINGERPRINT,
    count: maskable.length,
    categories: [...categories],
    hadCriticalOrHigh: textFingerprint !== null ? scan.hasCriticalOrHigh : false,
    changedSinceAcknowledged: hadPriorAck,
    messageHasSensitiveText: textFingerprint !== null,
  }
  if (file === null) return base
  const fileSummary: DecisionFileSummary = {
    status: file.status === 'unable-to-inspect' ? 'unable-to-inspect' : 'detected',
    fileCount: file.fileCount ?? 1,
    categories: file.summary?.categories ?? [],
    count: file.summary?.count ?? 0,
    hasCriticalOrHigh: file.summary?.hasCriticalOrHigh ?? false,
  }
  return { ...base, file: fileSummary }
}
