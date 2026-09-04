// V1.3 submit-protection ("Protection at Send") feature flag.
//
// M1 ships the site-agnostic core state machine **default OFF**.
// Nothing in the live content script consults the core until a site
// adapter (M2/M3) attaches, and the adapter itself gates on this
// flag, so M1 causes zero observable behaviour change and can merge
// safely. Mirrors `src/content/document-flag.ts`: a compile-time
// default plus an optional `globalThis` override so tests can flip
// it per case without rebuilding the module graph.

const COMPILE_TIME_DEFAULT = false

interface SubmitFlagOverride {
  __AI_LEAK_GUARD_SUBMIT_FLAG__?: boolean
}

/**
 * True when the V1.3 submit-protection surface is enabled. When
 * false, `SubmitCore.handleSendIntent` returns `handled: false`
 * without holding anything, and adapters must not intercept the
 * site's native send. Read once per call site, never cached.
 */
export function isSubmitProtectionEnabled(): boolean {
  const override = (globalThis as SubmitFlagOverride).__AI_LEAK_GUARD_SUBMIT_FLAG__
  if (typeof override === 'boolean') return override
  return COMPILE_TIME_DEFAULT
}
