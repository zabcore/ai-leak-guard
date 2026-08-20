// Unit tests for the pure `scan-result` folder — no jsdom needed.
//
// Exercises the three states (`clean` / `sensitive` / `unable_to_inspect`),
// the `isMaskable` gate that keeps bare clinical-context signals from
// flipping a file to sensitive, and the aggregate roll-up across a
// multi-file drop.

import { describe, expect, it } from 'vitest'
import { detectDetailed } from '../../src/detector/engine'
import { DetectorCategory } from '../../src/detector/types'
import type { ExtractionResult } from '../../src/content/extraction/extract'
import {
  aggregateScanResults,
  scanResultFor,
  type DocScanResult,
} from '../../src/content/extraction/scan-result'

function extractedResult(text: string, name = 'doc.txt'): ExtractionResult {
  return {
    status: 'extracted',
    text,
    meta: { name, size: text.length, type: 'text/plain', detectedFormat: 'text' },
  }
}

function emptyResult(): ExtractionResult {
  return {
    status: 'empty',
    text: '',
    reason: 'empty',
    meta: { name: 'blank.txt', size: 0, type: 'text/plain', detectedFormat: 'text' },
  }
}

function unableResult(reason: ExtractionResult['reason'] = 'unsupported-type'): ExtractionResult {
  return {
    status: 'unable_to_inspect',
    text: '',
    reason,
    meta: { name: 'x.bin', size: 0, type: 'application/octet-stream', detectedFormat: 'unknown' },
  }
}

describe('scanResultFor', () => {
  it('extracted + real identifier → sensitive with maskable count and category', () => {
    // SSN pattern with a validated payload — the paste path masks
    // this today; the document path must agree.
    const extraction = extractedResult('Patient SSN: 123-45-6789 in the record.')
    const detection = detectDetailed(extraction.text)
    const scan = scanResultFor(extraction, detection)
    expect(scan.state).toBe('sensitive')
    expect(scan.maskableCount).toBeGreaterThanOrEqual(1)
    expect(scan.categories).toContain(DetectorCategory.GOVERNMENT_FINANCIAL)
    expect(scan.hasCriticalOrHigh).toBe(true)
  })

  it('extracted + only clinical context (ICD/CPT alone) → clean via isMaskable gate', () => {
    // ICD-10 code by itself is a low-signal detector — it participates
    // in scoring but must NEVER flip a file to sensitive on its own.
    // (Mirrors paste-path behavior: `hasCriticalOrHigh` is false and
    // masking is skipped for context-only findings.)
    const extraction = extractedResult('Discharge diagnosis: E11.9 type 2 diabetes.')
    const detection = detectDetailed(extraction.text)
    const scan = scanResultFor(extraction, detection)
    expect(scan.state).toBe('clean')
    expect(scan.maskableCount).toBe(0)
    expect(scan.categories).toEqual([])
    expect(scan.hasCriticalOrHigh).toBe(false)
  })

  it('extracted + no matches at all → clean', () => {
    const extraction = extractedResult('The quick brown fox jumps over the lazy dog.')
    const scan = scanResultFor(extraction, detectDetailed(extraction.text))
    expect(scan.state).toBe('clean')
    expect(scan.maskableCount).toBe(0)
  })

  it('empty → clean, does NOT need detection input', () => {
    const scan = scanResultFor(emptyResult(), null)
    expect(scan.state).toBe('clean')
    expect(scan.maskableCount).toBe(0)
  })

  it('unable_to_inspect → carries the extraction reason', () => {
    const scan = scanResultFor(unableResult('encrypted'), null)
    expect(scan.state).toBe('unable_to_inspect')
    expect(scan.reason).toBe('encrypted')
    expect(scan.maskableCount).toBe(0)
  })
})

describe('aggregateScanResults', () => {
  const sensitive: DocScanResult = {
    state: 'sensitive',
    maskableCount: 2,
    categories: [DetectorCategory.HEALTHCARE_PATIENT_ID],
    hasCriticalOrHigh: true,
  }
  const clean: DocScanResult = {
    state: 'clean',
    maskableCount: 0,
    categories: [],
    hasCriticalOrHigh: false,
  }
  const unable: DocScanResult = {
    state: 'unable_to_inspect',
    maskableCount: 0,
    categories: [],
    hasCriticalOrHigh: false,
    reason: 'no-text-layer',
  }

  it('any sensitive file → aggregate is sensitive (beats unable, beats clean)', () => {
    const agg = aggregateScanResults([sensitive, unable, clean])
    expect(agg.state).toBe('sensitive')
    expect(agg.totalMaskable).toBe(2)
    expect(agg.anyCriticalOrHigh).toBe(true)
    expect(agg.perStateCounts).toEqual({ sensitive: 1, clean: 1, unable: 1 })
  })

  it('unable present, no sensitive → aggregate is unable_to_inspect', () => {
    const agg = aggregateScanResults([unable, clean])
    expect(agg.state).toBe('unable_to_inspect')
    expect(agg.totalMaskable).toBe(0)
  })

  it('all clean → aggregate is clean', () => {
    const agg = aggregateScanResults([clean, clean])
    expect(agg.state).toBe('clean')
    expect(agg.perStateCounts).toEqual({ sensitive: 0, clean: 2, unable: 0 })
  })

  it('empty input → aggregate is clean, zeroed counts', () => {
    const agg = aggregateScanResults([])
    expect(agg.state).toBe('clean')
    expect(agg.totalMaskable).toBe(0)
    expect(agg.perStateCounts).toEqual({ sensitive: 0, clean: 0, unable: 0 })
  })

  it('deduplicates categories across files', () => {
    const a: DocScanResult = { ...sensitive, categories: [DetectorCategory.HEALTHCARE_PATIENT_ID] }
    const b: DocScanResult = {
      ...sensitive,
      categories: [DetectorCategory.HEALTHCARE_PATIENT_ID, DetectorCategory.IDENTITY],
    }
    const agg = aggregateScanResults([a, b])
    expect(agg.categories).toEqual([
      DetectorCategory.HEALTHCARE_PATIENT_ID,
      DetectorCategory.IDENTITY,
    ])
  })
})
