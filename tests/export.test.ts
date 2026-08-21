// V1.2 A5.1 local export test.
//
// Pins:
//   • the seven-field allowlist — no `value` / `text` / `content`
//     / `name` / `filename` / `body` / `raw` in ANY exported row,
//     for both CSV and JSON;
//   • timestamps are ISO strings;
//   • CSV round-trips a 200-event ring back to the same schema
//     (header row + 200 body rows);
//   • JSON serialises to a metadata-only array;
//   • the downloader is a `blob:` URL (no `fetch`, no network),
//     with a filename shaped `ai-leak-guard-activity-YYYYMMDD.<ext>`.

import { describe, expect, it, vi } from 'vitest'
import { DetectorCategory } from '../src/detector/types'
import type { AlgEvent } from '../src/shared/event-log'
import {
  EXPORT_FIELDS,
  exportCsv,
  exportJson,
  makeExportFilename,
  toCsv,
  toExportRows,
  toJson,
} from '../src/popup/export'

const FORBIDDEN = ['value', 'text', 'content', 'name', 'filename', 'body', 'raw']

function evt(overrides: Partial<AlgEvent> = {}): AlgEvent {
  return {
    ts: 1_700_000_000_000, // 2023-11-14T22:13:20.000Z
    site: 'chatgpt',
    eventType: 'paste',
    action: 'protected',
    categories: [DetectorCategory.GOVERNMENT_FINANCIAL],
    count: 1,
    hadCriticalOrHigh: true,
    ...overrides,
  }
}

describe('export — toExportRows (allowlist projection)', () => {
  it('projects every AlgEvent onto exactly the seven schema fields', () => {
    const hostile = {
      ...evt(),
      value: 'PATIENT_SSN',
      text: 'Patient MRN',
      filename: 'x.xlsx',
      body: 'anything',
      raw: 'anything',
    } as unknown as AlgEvent

    const [row] = toExportRows([hostile])
    expect(Object.keys(row).sort()).toEqual([...EXPORT_FIELDS].sort())
    for (const forbidden of FORBIDDEN) {
      expect(row, `row should not carry ${forbidden}`).not.toHaveProperty(forbidden)
    }
  })

  it('converts ts to an ISO 8601 string', () => {
    const [row] = toExportRows([evt({ ts: 1_700_000_000_000 })])
    expect(row.ts).toBe('2023-11-14T22:13:20.000Z')
  })
})

describe('export — CSV serialiser', () => {
  it('emits header + one row per event; no forbidden fields present', () => {
    const rows = toExportRows([
      evt({ site: 'chatgpt', action: 'protected', count: 3 }),
      evt({
        site: 'claude',
        eventType: 'document',
        action: 'uploaded-anyway',
        count: 5,
        categories: [DetectorCategory.HEALTHCARE_PATIENT_ID, DetectorCategory.PROVIDER_ID],
      }),
    ])
    const csv = toCsv(rows)
    const lines = csv.trim().split('\n')
    expect(lines[0]).toBe(EXPORT_FIELDS.join(','))
    expect(lines).toHaveLength(3)
    for (const forbidden of FORBIDDEN) {
      expect(csv).not.toContain(forbidden + ',')
      expect(csv).not.toContain(',' + forbidden)
    }
    // Pipes separate multiple categories in the flat CSV cell.
    expect(lines[2]).toContain('healthcare_patient_id|provider_id')
  })

  it('empty rows → header-only CSV', () => {
    const csv = toCsv([])
    expect(csv).toBe(`${EXPORT_FIELDS.join(',')}\n`)
  })

  it('round-trips a 200-event ring back to a 201-line CSV', () => {
    const events: AlgEvent[] = []
    for (let i = 0; i < 200; i++) {
      events.push(evt({ ts: 1_700_000_000_000 + i * 1000, count: (i % 5) + 1 }))
    }
    const csv = toCsv(toExportRows(events))
    const lines = csv.trim().split('\n')
    expect(lines).toHaveLength(201) // header + 200 body rows
    // Assert timestamps are ISO in every body row.
    for (let i = 1; i <= 200; i++) {
      const first = lines[i].split(',')[0]
      expect(first).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    }
  })
})

describe('export — JSON serialiser', () => {
  it('emits a valid array of metadata-only records', () => {
    const rows = toExportRows([evt({ count: 2 })])
    const json = toJson(rows)
    const parsed = JSON.parse(json) as Array<Record<string, unknown>>
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed).toHaveLength(1)
    expect(Object.keys(parsed[0]).sort()).toEqual([...EXPORT_FIELDS].sort())
    for (const forbidden of FORBIDDEN) {
      expect(parsed[0]).not.toHaveProperty(forbidden)
      expect(json).not.toContain(`"${forbidden}"`)
    }
  })
})

describe('export — filename', () => {
  it('renders like ai-leak-guard-activity-YYYYMMDD.<ext>', () => {
    const now = new Date('2026-08-21T12:34:56Z')
    expect(makeExportFilename('csv', now)).toBe('ai-leak-guard-activity-20260821.csv')
    expect(makeExportFilename('json', now)).toBe('ai-leak-guard-activity-20260821.json')
  })
})

describe('export — download uses Blob + no network', () => {
  it('exportCsv builds a Blob and hands it to the download seam', () => {
    // Assert `fetch` is NEVER called on the export path.
    const fetchSpy = vi.fn()
    const originalFetch = globalThis.fetch
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    try {
      const capture: Array<{ blob: Blob; filename: string }> = []
      exportCsv([evt(), evt({ site: 'claude' })], {
        triggerDownload: (blob, filename) => capture.push({ blob, filename }),
      })
      expect(capture).toHaveLength(1)
      expect(capture[0].filename).toMatch(/^ai-leak-guard-activity-\d{8}\.csv$/)
      // Blob mime type is CSV; no HTTP request happened.
      expect(capture[0].blob.type).toMatch(/^text\/csv/)
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('exportJson builds a JSON Blob', () => {
    const capture: Array<{ blob: Blob; filename: string }> = []
    exportJson([evt()], {
      triggerDownload: (blob, filename) => capture.push({ blob, filename }),
    })
    expect(capture).toHaveLength(1)
    expect(capture[0].filename).toMatch(/^ai-leak-guard-activity-\d{8}\.json$/)
    expect(capture[0].blob.type).toBe('application/json')
  })
})
