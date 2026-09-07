// V1.3 submit-protection ("Protection at Send") feature flag.
//
// M1–M6 shipped the core, the three site adapters, the text/file
// coordination, and the self-test all behind this flag **default OFF**,
// so nothing changed for users while the surface was built and audited.
// M7 (v1.3.0) flips the compile-time default **ON**: this is the go-live
// switch. On ChatGPT/Claude/Gemini the submit adapters now install and
// the send-time scan is active by default. No new permissions, so the
// Chrome auto-update rolls it out silently. Mirrors
// `src/content/document-flag.ts`: a compile-time default plus an optional
// `globalThis` override so tests (or a throwaway build) can flip it per
// case without rebuilding the module graph.

const COMPILE_TIME_DEFAULT = true

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
