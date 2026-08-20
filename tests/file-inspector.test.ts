// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { aggregateFindings, inspectFiles } from '../src/content/file-inspector'

// pdf.js can't run in jsdom (no Worker) — mock it so any test that
// happens to route a PDF-shaped file through inspectFiles doesn't
// spawn a real worker. The default plan returns one page of stub
// text so the extractor reports `extracted`.
vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerPort: {} },
  getDocument: () => ({
    promise: Promise.resolve({
      numPages: 1,
      getPage: async () => ({
        getTextContent: async () => ({ items: [{ str: 'stub' }] }),
        cleanup: () => {},
      }),
      destroy: async () => {},
    }),
  }),
}))

describe('inspectFiles (A3)', () => {
  it('returns one entry per input file with extraction + scan + aggregate', async () => {
    const a = new File(['hello world sentinel'], 'a.txt', { type: 'text/plain' })
    const b = new File([new Uint8Array([0x00, 0x01, 0x02, 0x03])], 'b.bin', {
      type: 'application/octet-stream',
    })
    const out = await inspectFiles([a, b])
    expect(out.perFile).toHaveLength(2)
    expect(out.aggregate).toBeDefined()

    // File a: text, no PHI-shaped identifiers → clean.
    expect(out.perFile[0].meta.file).toBe(a)
    expect(out.perFile[0].meta.name).toBe('a.txt')
    expect(out.perFile[0].extraction.status).toBe('extracted')
    expect(out.perFile[0].extraction.text).toContain('sentinel')
    expect(out.perFile[0].scan.state).toBe('clean')
    // File b: unknown binary → unable_to_inspect / unsupported-type.
    expect(out.perFile[1].extraction.status).toBe('unable_to_inspect')
    expect(out.perFile[1].extraction.reason).toBe('unsupported-type')
    expect(out.perFile[1].scan.state).toBe('unable_to_inspect')
    expect(out.perFile[1].scan.reason).toBe('unsupported-type')

    // Aggregate: no sensitive files, one unable → aggregate is
    // 'unable_to_inspect'.
    expect(out.aggregate.state).toBe('unable_to_inspect')
    expect(out.aggregate.perStateCounts).toEqual({ sensitive: 0, clean: 1, unable: 1 })
  })

  it('holds the original File reference, not a copy', async () => {
    const file = new File(['hi'], 'a.txt', { type: 'text/plain' })
    const out = await inspectFiles([file])
    expect(out.perFile[0].meta.file).toBe(file)
  })

  it('returns an empty perFile list and a zeroed aggregate for empty input', async () => {
    const out = await inspectFiles([])
    expect(out.perFile).toEqual([])
    expect(out.aggregate.state).toBe('clean')
    expect(out.aggregate.totalMaskable).toBe(0)
    expect(out.aggregate.perStateCounts).toEqual({ sensitive: 0, clean: 0, unable: 0 })
  })

  it('never rejects — a single unreadable file becomes unable_to_inspect', async () => {
    const bad = new File([new Uint8Array([0xff, 0xff, 0xff])], 'weird.bin', {
      type: 'application/octet-stream',
    })
    const out = await inspectFiles([bad])
    expect(out.perFile[0].extraction.status).toBe('unable_to_inspect')
    expect(out.perFile[0].scan.state).toBe('unable_to_inspect')
  })
})

describe('aggregateFindings', () => {
  it('flattens per-file findings into a single list, preserving order', () => {
    const inspection = {
      perFile: [
        {
          meta: {
            file: new File(['x'], 'a.pdf'),
            name: 'a.pdf',
            size: 1,
            type: 'application/pdf',
          },
          extraction: {
            status: 'extracted' as const,
            text: 'x',
            meta: {
              name: 'a.pdf',
              size: 1,
              type: 'application/pdf',
              detectedFormat: 'pdf' as const,
            },
          },
          findings: [
            {
              ruleId: 'a',
              label: 'A',
              severity: 'high' as const,
              start: 0,
              end: 1,
              value: 'x',
            },
          ],
          scan: {
            state: 'sensitive' as const,
            maskableCount: 1,
            categories: [],
            hasCriticalOrHigh: true,
          },
        },
        {
          meta: {
            file: new File(['y'], 'b.pdf'),
            name: 'b.pdf',
            size: 1,
            type: 'application/pdf',
          },
          extraction: {
            status: 'extracted' as const,
            text: 'y',
            meta: {
              name: 'b.pdf',
              size: 1,
              type: 'application/pdf',
              detectedFormat: 'pdf' as const,
            },
          },
          findings: [
            {
              ruleId: 'b',
              label: 'B',
              severity: 'high' as const,
              start: 0,
              end: 1,
              value: 'y',
            },
          ],
          scan: {
            state: 'sensitive' as const,
            maskableCount: 1,
            categories: [],
            hasCriticalOrHigh: true,
          },
        },
      ],
      aggregate: {
        state: 'sensitive' as const,
        totalMaskable: 2,
        categories: [],
        anyCriticalOrHigh: true,
        perStateCounts: { sensitive: 2, clean: 0, unable: 0 },
      },
    }
    const flat = aggregateFindings(inspection)
    expect(flat.map((f) => f.ruleId)).toEqual(['a', 'b'])
  })

  it('returns an empty list when nothing was inspected', () => {
    expect(
      aggregateFindings({
        perFile: [],
        aggregate: {
          state: 'clean',
          totalMaskable: 0,
          categories: [],
          anyCriticalOrHigh: false,
          perStateCounts: { sensitive: 0, clean: 0, unable: 0 },
        },
      }),
    ).toEqual([])
  })
})
