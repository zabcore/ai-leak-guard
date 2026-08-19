// Cross-world message contract for the V1.2 A1.1 FSA hook.
//
// This module is deliberately import-free — the MAIN-world script
// (isolated JS context, no access to the extension's isolated-world
// bundle) and the isolated-world content script both build against
// the same shapes and validators without pulling in Chrome APIs,
// Node types, or any DOM helpers. Values marshalled across the world
// boundary are strictly metadata: `{ name, size, type }` per file, an
// `id` string, and a decision string. No `File` objects, no `Blob`s,
// no handles, no bytes — the "hold references only, don't read
// contents" invariant established in A1 (`docs/ARCHITECTURE.md`)
// applies across the world boundary too.

export const FSA_MESSAGE_SOURCE = 'alg-fsa'

export type FsaDecision = 'upload-anyway' | 'cancel'

export interface FsaFileMetadata {
  readonly name: string
  readonly size: number
  readonly type: string
}

export interface FsaHoldRequest {
  readonly source: typeof FSA_MESSAGE_SOURCE
  readonly kind: 'hold-request'
  readonly id: string
  readonly files: readonly FsaFileMetadata[]
}

export interface FsaHoldDecision {
  readonly source: typeof FSA_MESSAGE_SOURCE
  readonly kind: 'hold-decision'
  readonly id: string
  readonly decision: FsaDecision
}

export type FsaMessage = FsaHoldRequest | FsaHoldDecision

// ─── Validation ─────────────────────────────────────────────────────────
// The isolated world MUST reject anything that fails these predicates
// so foreign scripts on the page cannot forge a decision (which would
// let a page release its own picker without user confirmation) or a
// bogus hold-request (which would open a modal out of nowhere).

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

function isString(x: unknown): x is string {
  return typeof x === 'string'
}

function isNonNegativeInteger(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x) && x >= 0
}

function isFsaFileMetadata(x: unknown): x is FsaFileMetadata {
  if (!isPlainObject(x)) return false
  return isString(x.name) && isNonNegativeInteger(x.size) && isString(x.type)
}

/**
 * True when `x` is a well-formed `hold-request` message. The isolated
 * world uses this to gate opening a modal.
 */
export function isFsaHoldRequest(x: unknown): x is FsaHoldRequest {
  if (!isPlainObject(x)) return false
  if (x.source !== FSA_MESSAGE_SOURCE) return false
  if (x.kind !== 'hold-request') return false
  if (!isString(x.id) || x.id.length === 0) return false
  if (!Array.isArray(x.files)) return false
  return x.files.every(isFsaFileMetadata)
}

/**
 * True when `x` is a well-formed `hold-decision` message. The MAIN
 * world uses this to gate resolving the wrapped picker's promise.
 */
export function isFsaHoldDecision(x: unknown): x is FsaHoldDecision {
  if (!isPlainObject(x)) return false
  if (x.source !== FSA_MESSAGE_SOURCE) return false
  if (x.kind !== 'hold-decision') return false
  if (!isString(x.id) || x.id.length === 0) return false
  return x.decision === 'upload-anyway' || x.decision === 'cancel'
}
