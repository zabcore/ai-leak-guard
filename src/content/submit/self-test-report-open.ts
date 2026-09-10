// V1.3 M5 / V1.3.1 §E — open the self-test "Report this" flow from the
// CONTENT SCRIPT.
//
// Content scripts have no `chrome.tabs`, so opening uses `window.open`
// inside the report button's user gesture (no permission, not
// popup-blocked). §E adds a PRE-OPEN PREVIEW and switches the default to
// the FIXED report page + a user-pasted diagnostics block (no run data
// in the URL). The extension still transmits nothing — it copies text
// and opens a tab; the USER pastes and submits.

import {
  buildSelfTestReportUrl,
  buildFixedReportUrl,
  buildDiagnosticsBlock,
  reportFields,
  coarseBrowser,
  adapterStateForResult,
  stepForCode,
  type SelfTestReportInput,
} from '../../shared/self-test-report'
import { showReportPreview } from './self-test-report-preview'
import type { SelfTestResultRecord } from '../../shared/self-test'

export interface ReportOpenDeps {
  /** Extension version; defaults to the manifest version. */
  readonly ext?: string
  /** UA string; defaults to `navigator.userAgent`. */
  readonly userAgent?: string
  /** Tab-open seam; defaults to `window.open(url, '_blank', 'noopener')`. */
  readonly open?: (url: string) => void
  /** Clipboard-copy seam; defaults to `navigator.clipboard.writeText`. */
  readonly copy?: (text: string) => void
  /**
   * Report style. `'fixed'` (default, scope §E): copy the block + open
   * the fixed page with NO run data. `'url'`: owner override — open the
   * legacy content-free URL-prefill instead. Both preview first.
   */
  readonly mode?: 'fixed' | 'url'
  /** Preview seam (tests inject a fake). Defaults to the real preview UI. */
  readonly preview?: typeof showReportPreview
}

/** Build the allowlist input from a result record (deriving §E fields). */
export function recordToReportInput(
  record: SelfTestResultRecord,
  deps: ReportOpenDeps = {},
): SelfTestReportInput {
  let ext = deps.ext
  if (ext === undefined) {
    try {
      ext = chrome.runtime?.getManifest?.().version ?? ''
    } catch {
      ext = ''
    }
  }
  const ua = deps.userAgent ?? globalThis.navigator?.userAgent
  return {
    site: record.site,
    ext,
    adapter: record.adapter,
    adapterState: adapterStateForResult(record.result),
    step: stepForCode(record.code),
    result: record.result,
    code: record.code,
    composer: record.composer,
    intercept: record.intercept,
    modal: record.modal,
    browser: coarseBrowser(ua),
    ts: record.ts,
  }
}

/** The legacy content-free URL (owner override). */
export function reportUrlForRecord(
  record: SelfTestResultRecord,
  deps: ReportOpenDeps = {},
): string {
  return buildSelfTestReportUrl(recordToReportInput(record, deps))
}

/**
 * Show the diagnostics PREVIEW; on proceed, copy the content-free block
 * and open the report page (fixed page by default — no run data — or the
 * legacy content-free URL under the `url` owner override). Dismiss
 * opens/copies nothing. The extension sends nothing.
 */
export function openSelfTestReport(record: SelfTestResultRecord, deps: ReportOpenDeps = {}): void {
  const input = recordToReportInput(record, deps)
  const fields = reportFields(input)
  const block = buildDiagnosticsBlock(input)

  const open =
    deps.open ??
    ((u: string): void => {
      window.open(u, '_blank', 'noopener')
    })
  const copy =
    deps.copy ??
    ((text: string): void => {
      try {
        void globalThis.navigator?.clipboard?.writeText?.(text)
      } catch {
        // best-effort; the preview also shows the block for manual copy
      }
    })
  const preview = deps.preview ?? showReportPreview

  preview(fields, block, {
    onProceed: () => {
      if (deps.mode === 'url') {
        // Owner override: legacy content-free URL-prefill.
        try {
          open(buildSelfTestReportUrl(input))
        } catch (err) {
          console.warn('[AI Leak Guard] self-test report open failed:', err)
        }
        return
      }
      // Default (scope §E): copy the block + open the FIXED page (no run
      // data). The user pastes the block on the page and submits.
      try {
        copy(block)
      } catch {
        // best-effort
      }
      try {
        open(buildFixedReportUrl())
      } catch (err) {
        console.warn('[AI Leak Guard] self-test report open failed:', err)
      }
    },
  })
}
