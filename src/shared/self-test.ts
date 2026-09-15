// V1.3 M5 — one-click "Test protection" self-test: shared contract.
//
// The popup and the content script coordinate through two one-shot
// `chrome.storage.local` keys (metadata only — no page content ever):
//   • SIGNAL  (`algSelfTest`)       — popup → content script: "run once".
//   • RESULT  (`algSelfTestResult`) — content script → popup: outcome.
//
// The self-test drives the REAL interception + scan + warning-modal path
// on SYNTHETIC data only, in a FRESH tab, and ALWAYS cancels (never
// submits). See `src/content/submit/self-test.ts` for the runner and
// `docs`/the URL contract for the report payload.

import { DetectorCategory } from '../detector/types'

/**
 * One synthetic self-test case: a fixed, obviously-fake identifier and the
 * detector category it must trip. Each is exercised INDEPENDENTLY (a single
 * combined string could pass on one identifier while another silently broke),
 * and a unit suite asserts each case fires exactly `expectedCategory` via the
 * detector's own category output — not merely "a warning appeared".
 *
 * NEVER real page content — the whole point is to exercise the path without
 * touching anything the user typed. Values chosen against the shipped rules:
 * a bare "Jane Doe" is intentionally NOT detected (on-device NER is out of
 * scope), so the name case uses an honorific+surname, which the name rule
 * does catch.
 */
export interface SelfTestCase {
  /** Stable id for logs/reports (content-free). */
  readonly id: string
  /** Human-facing label for the identifier kind. */
  readonly label: string
  /** The synthetic identifier text injected into the composer. */
  readonly text: string
  /** The detector category this case must produce. */
  readonly expectedCategory: DetectorCategory
}

/** The independent self-test cases: name, MRN, and DOB (numeric + written month). */
export const SELF_TEST_CASES: readonly SelfTestCase[] = [
  {
    id: 'name',
    label: 'Name',
    text: 'Mrs. Jane Doe',
    expectedCategory: DetectorCategory.IDENTITY,
  },
  {
    id: 'mrn',
    label: 'MRN',
    text: 'MRN 12345678',
    expectedCategory: DetectorCategory.HEALTHCARE_PATIENT_ID,
  },
  {
    id: 'dob-numeric',
    label: 'Date of birth (numeric)',
    text: 'DOB 01/02/1980',
    expectedCategory: DetectorCategory.IDENTITY,
  },
  {
    id: 'dob-written',
    label: 'Date of birth (written month)',
    text: 'DOB January 2, 1980',
    expectedCategory: DetectorCategory.IDENTITY,
  },
] as const

/** Popup-facing outcome. `fail`/`unsupported` reveal the "Report this" button. */
export type SelfTestResultKind = 'confirmed' | 'fail' | 'unsupported'

/** Machine-readable diagnostic code (allowlisted for the report URL). */
export type SelfTestCode =
  | 'OK'
  | 'NO_COMPOSER'
  | 'DRAFT_PRESENT'
  | 'NO_INTERCEPT'
  | 'NO_MODAL'
  | 'TIMEOUT'
  | 'INIT_FAIL'

/** popup → content script. One-shot; the content script deletes it after running. */
export interface SelfTestSignal {
  readonly nonce: string
  readonly ts: number
  /** The origin the popup opened the fresh tab on (diagnostic only). */
  readonly site: string
}

/** content script → popup. Metadata only — no composer text, filenames, or findings. */
export interface SelfTestResultRecord {
  readonly nonce: string
  readonly result: SelfTestResultKind
  readonly code: SelfTestCode
  readonly site: string
  readonly adapter: string
  /** Booleans as 0/1 for a compact, content-free diagnostic. */
  readonly composer: 0 | 1
  readonly intercept: 0 | 1
  readonly modal: 0 | 1
  /** ISO-8601 timestamp of the run. */
  readonly ts: string
}

export const SELF_TEST_SIGNAL_KEY = 'algSelfTest'
export const SELF_TEST_RESULT_KEY = 'algSelfTestResult'

/** How long the popup waits for a result before reporting "couldn't start". */
export const SELF_TEST_POPUP_TIMEOUT_MS = 15000
