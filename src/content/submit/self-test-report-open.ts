// V1.3 M5 (follow-up 2) — open the self-test "Report this" page from the
// CONTENT SCRIPT.
//
// The bug this fixes: content scripts do NOT have `chrome.tabs` (only a
// subset — runtime/storage/i18n), so the earlier `chrome.tabs.create(...)`
// call in the content script silently no-op'd. The banner's report button
// runs inside a real user gesture, so a plain `window.open` is not
// popup-blocked and needs no permission. The extension still transmits
// nothing — it opens a tab to the prefilled page; the user submits there.
//
// (The POPUP's own report path legitimately uses `chrome.tabs.create` —
// the popup is an extension page and has `chrome.tabs`. That path is
// unchanged.)

import { buildSelfTestReportUrl, coarseBrowser } from '../../shared/self-test-report'
import type { SelfTestResultRecord } from '../../shared/self-test'

export interface ReportOpenDeps {
  /** Extension version; defaults to the manifest version. */
  readonly ext?: string
  /** UA string; defaults to `navigator.userAgent`. */
  readonly userAgent?: string
  /** Tab-open seam; defaults to `window.open(url, '_blank', 'noopener')`. */
  readonly open?: (url: string) => void
}

/** Build the allowlisted report URL from a self-test result record. */
export function reportUrlForRecord(
  record: SelfTestResultRecord,
  deps: ReportOpenDeps = {},
): string {
  let ext = deps.ext
  if (ext === undefined) {
    try {
      ext = chrome.runtime?.getManifest?.().version ?? ''
    } catch {
      ext = ''
    }
  }
  const ua = deps.userAgent ?? globalThis.navigator?.userAgent
  return buildSelfTestReportUrl({
    site: record.site,
    ext,
    adapter: record.adapter,
    result: record.result,
    code: record.code,
    composer: record.composer,
    intercept: record.intercept,
    modal: record.modal,
    browser: coarseBrowser(ua),
    ts: record.ts,
  })
}

/**
 * Open the prefilled zabcore report page for a self-test result. Uses
 * `window.open` (available in the content script's page context) — NOT
 * `chrome.tabs`, which content scripts don't have. Metadata only; the
 * extension sends nothing.
 */
export function openSelfTestReport(record: SelfTestResultRecord, deps: ReportOpenDeps = {}): void {
  const url = reportUrlForRecord(record, deps)
  const open =
    deps.open ??
    ((u: string): void => {
      window.open(u, '_blank', 'noopener')
    })
  try {
    open(url)
  } catch (err) {
    console.warn('[AI Leak Guard] self-test report open failed:', err)
  }
}
