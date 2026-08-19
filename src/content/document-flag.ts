// V1.2 document-protection feature flag.
//
// Ships **default OFF** through V1.2 A1, A2, and A3. Flipping it to true
// enables the file-interception seams (change / drop / paste-with-files),
// the placeholder confirm modal, and the hold/release orchestration.
// Flag OFF must be byte-for-byte identical to V1.1.1 — no listeners
// registered, no side effects at import time — and there is a
// dedicated flag-OFF guard test that asserts exactly that.
//
// Reads from an optional `globalThis.__AI_LEAK_GUARD_DOC_FLAG__` if set,
// so tests (and, in a later release, a local `chrome.storage.local`
// preference plumbed through the popup) can flip it without touching
// this file. Absent that override, the compile-time constant below is
// authoritative.

const COMPILE_TIME_DEFAULT = false

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
