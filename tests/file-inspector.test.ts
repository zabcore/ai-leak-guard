// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { aggregateFindings, inspectFiles } from '../src/content/file-inspector'

describe('inspectFiles (A1 stub)', () => {
  it('returns one entry per input file, each with an empty findings list', () => {
    const a = new File(['x'], 'a.pdf', { type: 'application/pdf' })
    const b = new File(['y'], 'b.png', { type: 'image/png' })
    const out = inspectFiles([a, b])
    expect(out.perFile).toHaveLength(2)
    expect(out.perFile[0].meta.file).toBe(a)
    expect(out.perFile[0].meta.name).toBe('a.pdf')
    expect(out.perFile[0].meta.type).toBe('application/pdf')
    expect(out.perFile[0].findings).toEqual([])
    expect(out.perFile[1].meta.file).toBe(b)
    expect(out.perFile[1].findings).toEqual([])
  })

  it('holds the original File reference, not a copy', () => {
    const file = new File(['bytes'], 'a.pdf', { type: 'application/pdf' })
    const out = inspectFiles([file])
    // Identity check — the stub must NOT clone.
    expect(out.perFile[0].meta.file).toBe(file)
  })

  it('returns an empty perFile list for an empty input', () => {
    expect(inspectFiles([]).perFile).toEqual([])
  })
})

describe('aggregateFindings', () => {
  it('flattens per-file findings into a single list, preserving order', () => {
    // Fabricate an inspection with populated findings to exercise the
    // helper — the A1 stub never produces findings itself.
    const inspection = {
      perFile: [
        {
          meta: {
            file: new File(['x'], 'a.pdf'),
            name: 'a.pdf',
            size: 1,
            type: 'application/pdf',
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
        },
        {
          meta: {
            file: new File(['y'], 'b.pdf'),
            name: 'b.pdf',
            size: 1,
            type: 'application/pdf',
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
        },
      ],
    }
    const flat = aggregateFindings(inspection)
    expect(flat.map((f) => f.ruleId)).toEqual(['a', 'b'])
  })

  it('returns an empty list when nothing was inspected', () => {
    expect(aggregateFindings({ perFile: [] })).toEqual([])
  })
})
