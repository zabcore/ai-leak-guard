// V1.3 M4 — document coordination gate.
//
// The SEND moment must reconcile TWO protections that today never talk
// to each other:
//   • V1.2 document/upload flow — warns at ATTACH time (`holdFiles` →
//     `resolveDocumentDecision`), then forgets its result.
//   • V1.3 submit-scan — reads composer TEXT at send, knows nothing
//     about any attached file.
//
// This module is the thin, in-memory bridge between them. The
// attach-time flow PUBLISHES its per-composer inspection lifecycle
// here (pending → clean / detected / unable-to-inspect, plus an
// acknowledged flag when the user chose "upload anyway"); the
// submit-core CONSULTS it at send so one message carrying both typed
// PHI and a flagged attachment shows ONE combined modal, and a send
// never races a file scan that is still running.
//
// STRICT SCOPE / PRIVACY
//   • In-memory ONLY. NEVER touches `chrome.storage` (blocker §10.11).
//   • Metadata ONLY: category enums, a maskable count, a status, and a
//     boolean. It holds NO file content and NO filenames — same
//     discipline as the event log and the modals.
//   • Keyed by the SAME `composerKey` the submit adapters use
//     ('chatgpt-composer' / 'claude-composer' / 'gemini-composer'), so
//     the attach side and the send side address the same registry slot.
//   • Session-lived, per content-script (per tab/frame). No persistence.

import type { DetectorCategory } from '../../detector/types'

export type DocGateStatus = 'none' | 'pending' | 'clean' | 'detected' | 'unable-to-inspect'

/** Metadata-only summary of a settled inspection. No content, no names. */
export interface DocGateSummary {
  readonly categories: readonly DetectorCategory[]
  readonly count: number
  readonly hasCriticalOrHigh: boolean
}

export interface DocGateSnapshot {
  readonly status: DocGateStatus
  /** Present only when `status === 'detected'`. */
  readonly summary?: DocGateSummary
  /**
   * Number of attached files in this inspection (≥1 once settled).
   * Drives the modal's "…and its attachment(s)" copy. Present for
   * 'detected' and 'unable-to-inspect'; absent for none/pending/clean.
   */
  readonly fileCount?: number
  /** User already chose "upload anyway" at attach time for THIS inspection. */
  readonly acknowledged: boolean
}

/** Optional cooperative-cancel signal for `whenDocSettled`. */
export interface DocGateAbortSignal {
  readonly aborted: boolean
}

interface GateRecord {
  status: DocGateStatus
  summary?: DocGateSummary
  fileCount?: number
  acknowledged: boolean
}

const NONE: DocGateSnapshot = { status: 'none', acknowledged: false }

// Per-composerKey registry. A missing key reads as `NONE`.
const records = new Map<string, GateRecord>()

// Waiters parked on `whenDocSettled`, resolved the moment a key leaves
// 'pending' (settle / clear). Kept separate from `records` so resolving
// them can never mutate gate state.
const waiters = new Map<string, Set<(snap: DocGateSnapshot) => void>>()

function snapshotOf(rec: GateRecord | undefined): DocGateSnapshot {
  if (rec === undefined) return NONE
  // Copy so a caller can't mutate our stored record. Only include
  // optional fields when set (keeps snapshots byte-comparable in tests).
  const snap: {
    status: DocGateStatus
    summary?: DocGateSummary
    fileCount?: number
    acknowledged: boolean
  } = { status: rec.status, acknowledged: rec.acknowledged }
  if (rec.summary !== undefined) snap.summary = rec.summary
  if (rec.fileCount !== undefined) snap.fileCount = rec.fileCount
  return snap
}

function wake(composerKey: string, snap: DocGateSnapshot): void {
  const set = waiters.get(composerKey)
  if (set === undefined) return
  waiters.delete(composerKey)
  for (const resolve of set) {
    try {
      resolve(snap)
    } catch {
      // A waiter's own continuation must never break the gate.
    }
  }
}

/** Inspection has STARTED for this composer's attachment(s). */
export function markDocPending(composerKey: string): void {
  records.set(composerKey, { status: 'pending', acknowledged: false })
  // No wake — 'pending' is not a settled state.
}

/**
 * Inspection SETTLED. `status` is the terminal document state
 * ('clean' | 'detected' | 'unable-to-inspect'); pass the metadata-only
 * `summary` for 'detected'. `acknowledged` defaults to whatever the
 * record already held (so a settle after an ack doesn't silently clear
 * it), else false.
 */
export function settleDoc(
  composerKey: string,
  settle: {
    readonly status: 'clean' | 'detected' | 'unable-to-inspect'
    readonly summary?: DocGateSummary
    /** Number of attached files; stored for 'detected' / 'unable-to-inspect'. */
    readonly fileCount?: number
    readonly acknowledged?: boolean
  },
): void {
  const prev = records.get(composerKey)
  const rec: GateRecord = {
    status: settle.status,
    summary: settle.status === 'detected' ? settle.summary : undefined,
    fileCount: settle.status === 'clean' ? undefined : settle.fileCount,
    acknowledged: settle.acknowledged ?? prev?.acknowledged ?? false,
  }
  records.set(composerKey, rec)
  wake(composerKey, snapshotOf(rec))
}

/** User chose "upload anyway" for THIS inspection (attach time or send). */
export function markDocAcknowledged(composerKey: string): void {
  const rec = records.get(composerKey)
  if (rec === undefined) return
  rec.acknowledged = true
}

/**
 * Drop this composer's document state entirely (back to 'none').
 * Called on a CONFIRMED send (the next message re-evaluates a fresh
 * attachment) and when the attachment is removed / the attach modal is
 * cancelled. Wakes any parked waiter with 'none' so a send never hangs
 * because the file it was waiting on went away.
 */
export function clearDoc(composerKey: string): void {
  records.delete(composerKey)
  wake(composerKey, NONE)
}

/** Current snapshot; `{status:'none',acknowledged:false}` when unknown. */
export function getDoc(composerKey: string): DocGateSnapshot {
  return snapshotOf(records.get(composerKey))
}

/**
 * Resolve when this composer's document state leaves 'pending'. If it
 * is not pending right now, resolves synchronously (next microtask)
 * with the current snapshot. The caller (submit-core) bounds the wait
 * with a watchdog and fails open on expiry — this promise never
 * rejects. `signal.aborted` (if already set) short-circuits to the
 * current snapshot; the watchdog is the authoritative bound.
 */
export function whenDocSettled(
  composerKey: string,
  signal?: DocGateAbortSignal,
): Promise<DocGateSnapshot> {
  const current = getDoc(composerKey)
  if (current.status !== 'pending' || signal?.aborted === true) {
    return Promise.resolve(current)
  }
  return new Promise<DocGateSnapshot>((resolve) => {
    let set = waiters.get(composerKey)
    if (set === undefined) {
      set = new Set()
      waiters.set(composerKey, set)
    }
    set.add(resolve)
  })
}

/** Test-only: wipe all gate state + waiters between tests. */
export function __resetDocumentGateForTests(): void {
  records.clear()
  for (const [key, set] of waiters) {
    for (const resolve of set) {
      try {
        resolve(NONE)
      } catch {
        // ignore
      }
    }
    waiters.delete(key)
  }
}
