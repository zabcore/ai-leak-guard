// @vitest-environment jsdom
//
// A3 wiring + parity tests. These prove:
//   • `inspectFiles` runs the V1.1 detector over `extraction.text`
//     and populates `findings` + `scan.state` correctly for a
//     realistic PHI-shaped document.
//   • Document-path findings equal paste-path findings for the same
//     text (parity — the two callers are the same engine).
//   • Empty / unable / clean fixtures pass through with the right
//     state and never run the detector twice.
//   • The scan-size guard rejects oversized text as
//     `too-large-to-scan` — never a silent truncate.
//   • A hostile (long, repetitive) input scans in bounded time
//     rather than pegging the pool.
//   • A per-file detector throw degrades that one file to
//     `unable_to_inspect / scan-error`; siblings still finish.
//   • Aggregate over a multi-file drop (sensitive + clean + unable).

import { afterEach, describe, expect, it, vi } from 'vitest'
import { detectDetailed } from '../../src/detector/engine'
import { MAX_SCAN_CHARS, inspectFiles } from '../../src/content/file-inspector'

function textFile(name: string, contents: string): File {
  return new File([contents], name, { type: 'text/plain' })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('inspectFiles (A3) — detection wiring', () => {
  it('populates findings + scan.state=sensitive for a PHI-shaped document', async () => {
    // SSN pattern is a validated, non-context detector — a paste of
    // this same text masks today.
    const sensitive = textFile('sensitive.txt', 'Patient SSN: 123-45-6789 in the record.')
    const out = await inspectFiles([sensitive])
    const entry = out.perFile[0]
    expect(entry.extraction.status).toBe('extracted')
    expect(entry.findings.length).toBeGreaterThanOrEqual(1)
    expect(entry.scan.state).toBe('sensitive')
    expect(entry.scan.maskableCount).toBeGreaterThanOrEqual(1)
    expect(entry.scan.hasCriticalOrHigh).toBe(true)
    expect(out.aggregate.state).toBe('sensitive')
    expect(out.aggregate.totalMaskable).toBeGreaterThanOrEqual(1)
    expect(out.aggregate.anyCriticalOrHigh).toBe(true)
  })

  it('clean text → findings: [], scan.state=clean', async () => {
    const clean = textFile('clean.txt', 'The quick brown fox jumps over the lazy dog.')
    const out = await inspectFiles([clean])
    expect(out.perFile[0].findings).toEqual([])
    expect(out.perFile[0].scan.state).toBe('clean')
    expect(out.aggregate.state).toBe('clean')
  })

  it('empty extraction → no scan, findings: [], scan.state=clean', async () => {
    // Text file with only whitespace → extractor reports `empty`.
    const blank = textFile('blank.txt', '   \n \t ')
    const out = await inspectFiles([blank])
    expect(out.perFile[0].extraction.status).toBe('empty')
    expect(out.perFile[0].findings).toEqual([])
    expect(out.perFile[0].scan.state).toBe('clean')
  })

  it('unable_to_inspect passes through — detection is not attempted', async () => {
    // A binary file with no matching sniff signature → unsupported-type.
    const bad = new File([new Uint8Array([0x00, 0x01, 0x02, 0x03])], 'x.bin', {
      type: 'application/octet-stream',
    })
    const out = await inspectFiles([bad])
    expect(out.perFile[0].extraction.status).toBe('unable_to_inspect')
    expect(out.perFile[0].extraction.reason).toBe('unsupported-type')
    expect(out.perFile[0].scan.state).toBe('unable_to_inspect')
    expect(out.perFile[0].scan.reason).toBe('unsupported-type')
    expect(out.perFile[0].findings).toEqual([])
  })
})

describe('inspectFiles (A3) — parity with the paste path', () => {
  // The document path is `detectDetailed(extraction.text)`; the paste
  // path is `detectDetailed(pastedText)`. Same engine, same rules,
  // same input → the findings arrays must be identical (rule ids,
  // labels, severities, spans, values, taxonomy fields).

  it('finds the same identifiers a paste of the same text would', async () => {
    const text =
      'Patient MRN: 12345678 with SSN 123-45-6789 discharged on 03/14/1979 with account 987654321012.'
    const pasteFindings = detectDetailed(text).findings
    const out = await inspectFiles([textFile('parity.txt', text)])
    const docFindings = [...out.perFile[0].findings]

    const norm = (fs: typeof pasteFindings) =>
      fs
        .map((f) => `${f.ruleId}|${f.start}|${f.end}|${f.value}|${f.effectiveSensitivity ?? ''}`)
        .sort()
    expect(norm(docFindings)).toEqual(norm(pasteFindings))
    expect(docFindings.length).toBeGreaterThan(0)
  })

  it('parity holds on a clean input too — both paths return []', async () => {
    const text = 'A pleasant morning walk in the park.'
    const pasteFindings = detectDetailed(text).findings
    const out = await inspectFiles([textFile('parity-clean.txt', text)])
    expect(out.perFile[0].findings).toEqual(pasteFindings)
    expect(pasteFindings).toEqual([])
  })
})

describe('inspectFiles (A3) — scan-size guard', () => {
  it('text longer than MAX_SCAN_CHARS → unable_to_inspect / too-large-to-scan (never false clean)', async () => {
    const big = textFile('big.txt', 'a'.repeat(MAX_SCAN_CHARS + 1))
    const out = await inspectFiles([big])
    const entry = out.perFile[0]
    expect(entry.extraction.status).toBe('unable_to_inspect')
    expect(entry.extraction.reason).toBe('too-large-to-scan')
    expect(entry.scan.state).toBe('unable_to_inspect')
    expect(entry.scan.reason).toBe('too-large-to-scan')
    expect(entry.findings).toEqual([])
  })

  it('text exactly at MAX_SCAN_CHARS is still scanned', async () => {
    const atCap = textFile('at-cap.txt', 'z'.repeat(MAX_SCAN_CHARS))
    const out = await inspectFiles([atCap])
    // Repeating `z` matches nothing → clean, not too-large.
    expect(out.perFile[0].extraction.status).toBe('extracted')
    expect(out.perFile[0].scan.state).toBe('clean')
  })
})

describe('inspectFiles (A3) — hostile-text bounded time', () => {
  it('a 1 MB adversarial text scans in bounded time (< 2 s)', async () => {
    // Build a mix that stresses several rule regexes at once:
    // repeated separators + long alnum runs (approx. developer-
    // credential / entropy triggers) + patterned digit groups that
    // look SSN/CC-shaped but should fail Luhn/exclusion checks. The
    // goal is not catastrophic backtracking (that would be a
    // detector-fix task, out of A3 scope) but to prove the size
    // guard doesn't need to fire on realistic large inputs.
    const chunk = 'lorem ipsum 000-00-0000 dolor sit AAAABBBBCCCCDDDDEEEE 1234567890123456 amet '
    const target = 1_000_000
    const repeats = Math.ceil(target / chunk.length)
    const text = chunk.repeat(repeats).slice(0, target)
    const file = textFile('hostile.txt', text)

    const started = Date.now()
    const out = await inspectFiles([file])
    const elapsed = Date.now() - started

    // Bounded time — 2 s is generous relative to typical
    // paste-path detection (<5 ms) so a per-rule pathology would
    // trip this well before hanging the test suite.
    expect(elapsed).toBeLessThan(2000)
    // Extraction still succeeded (file was under the extraction
    // 20 MB cap AND under the scan MAX_SCAN_CHARS cap).
    expect(out.perFile[0].extraction.status).toBe('extracted')
  })
})

describe('inspectFiles (A3) — per-file try/catch', () => {
  it('detector throw on one file degrades to scan-error; siblings still finish', async () => {
    // Force a controlled detector failure by spying on the engine
    // export. Only affects THIS test.
    const engineMod = await import('../../src/detector/engine')
    let called = 0
    const spy = vi.spyOn(engineMod, 'detectDetailed').mockImplementation((text: string) => {
      called += 1
      if (text.includes('BOOM')) throw new Error('synthetic detector panic')
      // Fall back to a minimal shape for the good file.
      return { findings: [], hasCriticalOrHigh: false }
    })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const bad = textFile('bad.txt', 'this file contains the BOOM marker')
    const good = textFile('good.txt', 'this file is fine')
    const out = await inspectFiles([bad, good])

    expect(out.perFile).toHaveLength(2)
    // Bad file → unable_to_inspect / scan-error.
    expect(out.perFile[0].extraction.status).toBe('unable_to_inspect')
    expect(out.perFile[0].extraction.reason).toBe('scan-error')
    expect(out.perFile[0].scan.state).toBe('unable_to_inspect')
    expect(out.perFile[0].scan.reason).toBe('scan-error')
    // Good file → clean.
    expect(out.perFile[1].extraction.status).toBe('extracted')
    expect(out.perFile[1].scan.state).toBe('clean')
    expect(called).toBe(2)
    expect(errSpy).toHaveBeenCalled()
    spy.mockRestore()
  })
})

describe('inspectFiles (A3) — aggregate over a multi-file drop', () => {
  it('sensitive + clean + unable → aggregate.state=sensitive, counts add up', async () => {
    const files = [
      textFile('a.txt', 'Patient SSN: 123-45-6789.'),
      textFile('b.txt', 'A plain sentence.'),
      new File([new Uint8Array([0xff, 0xff, 0xff])], 'c.bin', {
        type: 'application/octet-stream',
      }),
    ]
    const out = await inspectFiles(files)
    expect(out.aggregate.state).toBe('sensitive')
    expect(out.aggregate.perStateCounts).toEqual({ sensitive: 1, clean: 1, unable: 1 })
    expect(out.aggregate.totalMaskable).toBeGreaterThanOrEqual(1)
    expect(out.aggregate.anyCriticalOrHigh).toBe(true)
  })
})
