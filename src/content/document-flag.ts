// V1.2 document-protection feature flag.
//
// V1.2 M6 GA (v1.2.0) ships **default ON**. Every A1–A5.1 gate ran
// behind this flag while the surface was iterated; the shipping
// build finally flips it. The flag itself is preserved (not
// deleted) so a test can still assert the OFF-path behavior and,
// if a future site regresses, a runtime override can turn the
// document-flow surface off without a new release.
//
// Flipping is the ONE and ONLY behavioural change in the M6
// release PR. Flag OFF still produces the V1.1.1-identical paste-
// only behavior (no file-interception listeners, no modal, no
// hold/release), asserted by the flag-OFF guard test.
//
// Reads from an optional `globalThis.__AI_LEAK_GUARD_DOC_FLAG__` if set,
// so tests (and, in a later release, a local `chrome.storage.local`
// preference plumbed through the popup) can flip it without touching
// this file. Absent that override, the compile-time constant below is
// authoritative.

const COMPILE_TIME_DEFAULT = true

interface DocumentFlagOverride {
  __AI_LEAK_GUARD_DOC_FLAG__?: boolean
}

/**
 * True when the V1.2 document-protection surface is enabled. When
 * false, callers must skip all file-interception behavior and let the
 * host's native paste/change/drop path proceed unchanged.
 *
 * A getter (not a re-exported const) so tests can flip the override
 * per case without rebuilding the module graph. Read once per call
 * site, not cached, so a mid-session change is honored by the very
 * next event.
 */
export function isDocumentProtectionEnabled(): boolean {
  const override = (globalThis as DocumentFlagOverride).__AI_LEAK_GUARD_DOC_FLAG__
  if (typeof override === 'boolean') return override
  return COMPILE_TIME_DEFAULT
}
