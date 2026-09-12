// V1.3.1 §Growth Loop — constants for the local review/referral prompt.
//
// This module is part of the INDEPENDENT growth loop: it can be removed or
// delayed without touching any protection logic. Nothing here reaches the
// network — the two URLs below are opened in a user-initiated tab
// (`chrome.tabs.create`) or copied to the clipboard on a user gesture; the
// extension never fetches them.

// ── Time windows (all in ms) ──────────────────────────────────────────────
// Named so the whole eligibility/suppression policy is tunable in one place
// and unit-testable with an injected clock.

const DAY_MS = 24 * 60 * 60 * 1000

/** Installed at least this long before the prompt can appear. */
export const INSTALL_MIN_AGE_MS = 3 * DAY_MS

/** How many counted "successful protection events" gate eligibility. */
export const MIN_PROTECTION_EVENTS = 3

/**
 * Collapse duplicate inspection of the SAME content: a counting event whose
 * risk shape matches the immediately-preceding counted event within this
 * window is not counted (covers paste-then-send of the same clipboard).
 */
export const DEDUP_WINDOW_MS = 120 * 1000

/** A "Not now" dismissal suppresses the prompt for this long. */
export const DISMISS_SUPPRESS_MS = 30 * DAY_MS

/** Second dismissal makes suppression permanent (until re-enabled). */
export const PERMANENT_DISMISS_COUNT = 2

// Failure-suppression windows — "a user having a bad experience sees SUPPORT,
// not a review request." Best-effort; some signals (self-test result, kill
// switch) are session-scoped and cleared elsewhere, so these windows only
// matter while the underlying signal still exists.

/** Suppress if a self-test failed within this window. */
export const SELF_TEST_FAIL_WINDOW_MS = DAY_MS

/** Suppress if the submit kill switch fired within this window. */
export const KILL_SWITCH_WINDOW_MS = DAY_MS

/** Suppress if the most recent activity event was `unable-to-inspect`. */
export const UNABLE_TO_INSPECT_WINDOW_MS = DAY_MS

/** Suppress for this long after the user opened the §E problem report. */
export const PROBLEM_REPORT_SUPPRESS_MS = 7 * DAY_MS

/** How long the "Link copied" confirmation label stays before reverting. */
export const LINK_COPIED_REVERT_MS = 2000

// ── URLs ──────────────────────────────────────────────────────────────────

/**
 * Chrome Web Store review page. Centralized here (mirroring how `WELCOME_URL`
 * is centralized in the service worker) so the owner fills the published
 * extension id in exactly ONE place.
 *
 * TODO(owner) — CONFIRM THIS VALUE before release: replace `<EXTENSION_ID>`
 * with the published extension id, e.g.
 *   https://chromewebstore.google.com/detail/abcdefghijklmnopabcdefghijklmnop/reviews
 * Until then the review CTA opens a Store URL with the placeholder id.
 */
export const STORE_REVIEW_URL =
  'https://chromewebstore.google.com/detail/<EXTENSION_ID>/reviews'

/**
 * Static install/landing link the referral CTA copies to the clipboard.
 * Copied verbatim on a user gesture — never fetched.
 */
export const INSTALL_LINK_URL = 'https://zabcore.com/install'

// ── Exact copy (spec §Growth Loop — do not paraphrase) ─────────────────────
// The prompt NEVER shows event counts and NEVER asks for "5 stars".

export const GROWTH_COPY = {
  heading: 'Finding AI Leak Guard useful?',
  sub: 'Help more healthcare teams discover it.',
  reviewCta: 'Leave an honest review',
  shareCta: 'Share with a colleague',
  dismissCta: 'Not now',
  /** Transient label shown after the referral link is copied. */
  linkCopied: 'Link copied',
  /** Small always-present re-entry link (settings/help) that re-enables it. */
  supportLink: 'Support AI Leak Guard',
} as const
