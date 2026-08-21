// V1.2 A5.1 local export.
//
// Free-tier, on-device export of the metadata event log to CSV or
// JSON. The whole file is built in-page as a `Blob`, wrapped in a
// `blob:` URL, and handed to a synthetic `<a download>` click.
// `URL.revokeObjectURL` runs on the next tick so the browser has
// already latched the URL to the download.
//
// Non-negotiable invariants (test-asserted):
//   • Metadata only — the exported rows carry ONLY the `AlgEvent`
//     schema fields: ts (ISO), site, eventType, action, categories,
//     count, hadCriticalOrHigh. No value / text / filename / body
//     / raw can appear even if a caller staples them on — the row
//     builders enumerate the fields explicitly.
//   • Local only — no `fetch`, no network access. `Blob` +
//     `createObjectURL` need no permission and no host access.
//     `chrome.downloads` is NOT requested (the manifest guard test
//     checks this).
//   • Free tier — this is the individual-user on-ramp. Cloud sync,
//     cross-device history, and team aggregation live in a
//     separate paid product; nothing here uploads.
//
// The formatters are exported so tests can pin their output shape
// without needing a DOM.

import type { AlgEvent } from '../shared/event-log'

/**
 * The seven schema fields — ONLY these ever cross the export
 * boundary. Enumerated as a const array so the CSV header, the
 * per-row selector, and the no-content guard test all agree.
 */
export const EXPORT_FIELDS = [
  'ts',
  'site',
  'eventType',
  'action',
  'categories',
  'count',
  'hadCriticalOrHigh',
] as const

/** Row shape after ISO-format conversion — the only shape any
 *  exporter serialises. */
export interface ExportRow {
  readonly ts: string
  readonly site: string
  readonly eventType: AlgEvent['eventType']
  readonly action: AlgEvent['action']
  readonly categories: readonly string[]
  readonly count: number
  readonly hadCriticalOrHigh: boolean
}

/**
 * Project every event through the seven-field allowlist and turn
 * the numeric `ts` into an ISO 8601 timestamp so a CSV a human
 * opens is immediately readable (Excel + Numbers auto-parse ISO).
 *
 * Never reads content — this is an explicit enumeration.
 */
export function toExportRows(events: readonly AlgEvent[]): ExportRow[] {
  const out: ExportRow[] = []
  for (const e of events) {
    out.push({
      ts: new Date(e.ts).toISOString(),
      site: e.site,
      eventType: e.eventType,
      action: e.action,
      // Fresh array — any subclassed-Array own properties on the
      // input can't ride through.
      categories: e.categories.map(String),
      count: e.count,
      hadCriticalOrHigh: e.hadCriticalOrHigh,
    })
  }
  return out
}

/**
 * RFC 4180-ish CSV escape: wrap in double quotes; escape embedded
 * double quotes by doubling them. Safe for any Unicode string —
 * the AlgEvent schema doesn't allow raw newlines in string fields
 * (`site`, `action`, category enums all come from closed enums),
 * but the escape handles them anyway.
 */
function csvCell(v: string | number | boolean | readonly string[]): string {
  const s = Array.isArray(v) ? v.join('|') : String(v)
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

/** Build the CSV text for a rows array. Header row + one row per event. */
export function toCsv(rows: readonly ExportRow[]): string {
  const header = EXPORT_FIELDS.join(',')
  const body = rows
    .map((row) =>
      EXPORT_FIELDS.map((field) => {
        const value = row[field] as string | number | boolean | readonly string[]
        return csvCell(value)
      }).join(','),
    )
    .join('\n')
  // Trailing newline — makes the file `wc -l`-friendly and lets
  // some Excel builds detect the last row.
  return body.length === 0 ? `${header}\n` : `${header}\n${body}\n`
}

/** Build a pretty-printed JSON blob body. */
export function toJson(rows: readonly ExportRow[]): string {
  return JSON.stringify(rows, null, 2)
}

/**
 * Build a filename slug like `ai-leak-guard-activity-20260821.<ext>`.
 * The date is taken from `now` so a test can pin the string; the
 * default is `new Date()`.
 */
export function makeExportFilename(ext: 'csv' | 'json', now: Date = new Date()): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `ai-leak-guard-activity-${y}${m}${d}.${ext}`
}

/**
 * Optional seams so tests can capture the Blob + filename +
 * mime-type without triggering a real `<a download>` click in
 * jsdom (which no-ops silently and returns nothing to assert on).
 */
export interface DownloadDeps {
  /** Injected in tests. Production omits and gets the DOM click. */
  readonly triggerDownload?: (blob: Blob, filename: string) => void
}

/**
 * Trigger a browser download for `text` under `filename`. Uses
 * `Blob` + `URL.createObjectURL` + a synthetic anchor click. No
 * network, no permission required. `revokeObjectURL` on the next
 * microtask so the browser has already opened the object URL.
 *
 * NEVER throws into the caller — a download failure logs a
 * warning and returns; the activity page keeps rendering.
 */
export function downloadText(
  text: string,
  filename: string,
  mime: string,
  deps: DownloadDeps = {},
): void {
  try {
    const blob = new Blob([text], { type: mime })
    if (deps.triggerDownload) {
      deps.triggerDownload(blob, filename)
      return
    }
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.rel = 'noopener'
    // Anchor MUST be in the DOM for some browsers to honor `.click()`
    // — appending, clicking, and immediately removing keeps the
    // effect purely programmatic.
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    void Promise.resolve().then(() => URL.revokeObjectURL(url))
  } catch (err) {
    console.warn('[AI Leak Guard] export download failed:', err)
  }
}

/** Convenience: build + download the CSV for a given event list. */
export function exportCsv(events: readonly AlgEvent[], deps: DownloadDeps = {}): void {
  const rows = toExportRows(events)
  downloadText(toCsv(rows), makeExportFilename('csv'), 'text/csv;charset=utf-8', deps)
}

/** Convenience: build + download the JSON for a given event list. */
export function exportJson(events: readonly AlgEvent[], deps: DownloadDeps = {}): void {
  const rows = toExportRows(events)
  downloadText(toJson(rows), makeExportFilename('json'), 'application/json', deps)
}
