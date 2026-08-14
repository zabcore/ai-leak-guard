import { describe, expect, it } from 'vitest'
import { detect } from '../src/detector/engine'
import { mask } from '../src/content/masker'
import { buildPreviewSummary, decidePasteAction } from '../src/content/preview-flow'

// Pure-logic tests — no DOM, no Chrome. The point of splitting the flow into
// `preview-flow.ts` was to keep these fast and independent of the modal's
// DOM machinery.

describe('decidePasteAction — zero-friction passthrough', () => {
  it('returns passthrough for plain prose (no findings at all)', () => {
    const result = decidePasteAction('The quick brown fox jumps over the lazy dog.')
    expect(result.action).toBe('passthrough')
  })

  it('returns passthrough for text below the min-length gate (empty findings)', () => {
    const result = decidePasteAction('short')
    expect(result.action).toBe('passthrough')
  })

  it('returns passthrough when the ONLY findings are LOW / clinical context', () => {
    // A bare medication name (LOW / clinical context) fires on the medication
    // detector but has effectiveSensitivity LOW → hasCriticalOrHigh is false,
    // so the paste flow must NOT intercept.
    const result = decidePasteAction('The patient is taking metformin daily.')
    expect(result.action).toBe('passthrough')
  })

  it('returns passthrough for an ICD-10 code alone (context, no identifier)', () => {
    const result = decidePasteAction('Diagnosis K12.9 documented in the note.')
    expect(result.action).toBe('passthrough')
  })
})

describe('decidePasteAction — intercept', () => {
  it('intercepts a text with an SSN', () => {
    const result = decidePasteAction('SSN 123-45-6789 on file')
    expect(result.action).toBe('intercept')
    if (result.action !== 'intercept') return
    expect(result.maskable.length).toBeGreaterThan(0)
    expect(result.maskable.every((f) => f.ruleId !== 'medication')).toBe(true)
  })

  it('intercepts on an MRN + medication (context is filtered out of maskable)', () => {
    const result = decidePasteAction('Chart for MRN: 12345678 prescribed metformin daily.')
    expect(result.action).toBe('intercept')
    if (result.action !== 'intercept') return
    // findings contains BOTH mrn and medication; maskable strips the LOW ones.
    expect(result.findings.some((f) => f.ruleId === 'medication')).toBe(true)
    expect(result.maskable.some((f) => f.ruleId === 'medication')).toBe(false)
    expect(result.maskable.some((f) => f.ruleId === 'mrn')).toBe(true)
  })
})

describe('buildPreviewSummary', () => {
  it('groups maskable findings by label with counts, LOW findings excluded', () => {
    const text = 'Patient: Sarah Khan DOB: 05/12/1980 with diagnosis K12.9 and metformin.'
    const findings = detect(text)
    const summary = buildPreviewSummary(text, findings)

    // patient_name + date_of_birth should count; icd10 + medication (LOW) should not.
    expect(summary.count).toBe(2)
    const labelSet = new Set(summary.groups.map((g) => g.label))
    expect(labelSet.has('Patient Name')).toBe(true)
    expect(labelSet.has('Date of Birth')).toBe(true)
    expect(labelSet.has('ICD-10 Code')).toBe(false)
    expect(labelSet.has('Medication')).toBe(false)
    for (const group of summary.groups) {
      expect(group.count).toBe(1)
    }
  })

  it('aggregates duplicates of the same label under one group with the summed count', () => {
    // Both SSNs must have valid area numbers (< 900, ≠ 666, ≠ 000);
    // `987-65-4321` would be rejected by `isValidSsn` and only one would fire.
    const text = 'Patient: Jane Doe SSN 123-45-6789 SSN 234-56-7890'
    const findings = detect(text)
    const summary = buildPreviewSummary(text, findings)
    const ssnGroup = summary.groups.find((g) => g.label === 'US Social Security Number')
    expect(ssnGroup).toBeDefined()
    expect(ssnGroup?.count).toBe(2)
  })

  it('protectedText is exactly `mask(text, maskable).text` (no drift)', () => {
    const text = 'Patient: Sarah Khan, MRN: 12345678, metformin 500mg daily'
    const findings = detect(text)
    const summary = buildPreviewSummary(text, findings)
    const maskable = findings.filter(
      (f) =>
        f.effectiveSensitivity === 'critical' ||
        f.effectiveSensitivity === 'high' ||
        f.effectiveSensitivity === undefined,
    )
    const expected = mask(text, maskable).text
    expect(summary.protectedText).toBe(expected)
  })

  it('protectedText leaves LOW/context tokens (medication) visible', () => {
    const text = 'Patient: Sarah Khan, metformin 500mg daily'
    const findings = detect(text)
    const summary = buildPreviewSummary(text, findings)
    // The medication word must survive in the protected preview because it
    // was filtered out of the maskable set. The patient name is redacted.
    expect(summary.protectedText.toLowerCase()).toContain('metformin')
    expect(summary.protectedText).toContain('[PATIENT_NAME]')
    expect(summary.protectedText).not.toContain('Sarah Khan')
  })

  it('empty findings → empty groups + protectedText equal to input', () => {
    const text = 'Hello world, nothing sensitive here.'
    const summary = buildPreviewSummary(text, [])
    expect(summary.count).toBe(0)
    expect(summary.groups).toEqual([])
    expect(summary.protectedText).toBe(text)
  })
})
