import { describe, expect, it } from 'vitest'
import { detect, isMaskable } from '../src/detector/engine'
import { mask } from '../src/content/masker'
import { SensitivityLevel } from '../src/detector/types'
import type { Finding } from '../src/detector/types'

function findingsFor(text: string, ruleId: string): Finding[] {
  return detect(text).filter((f) => f.ruleId === ruleId)
}

function firstOf(text: string, ruleId: string): Finding {
  const [f] = findingsFor(text, ruleId)
  if (f === undefined) throw new Error(`no ${ruleId} finding in: ${text}`)
  return f
}

// ─── patient_name — positive ──────────────────────────────────────────────────

describe('patient_name — anchor labels (positive)', () => {
  it('fires on `Patient: <name>`', () => {
    expect(firstOf('Patient: Sarah Khan', 'patient_name').value).toContain('Sarah Khan')
  })

  it('fires on `Patient Name: <name>`', () => {
    expect(firstOf('Patient Name: Sarah Khan', 'patient_name').value).toContain('Sarah Khan')
  })

  it('fires on `Patient Name - <name>` (hyphen separator)', () => {
    expect(firstOf('Patient Name - Sarah Khan', 'patient_name').value).toContain('Sarah Khan')
  })

  it('fires on `Patient – <name>` (en-dash separator)', () => {
    expect(firstOf('Patient – Sarah Khan', 'patient_name').value).toContain('Sarah Khan')
  })

  it('fires on `Patient = <name>` (equals separator)', () => {
    expect(firstOf('Patient = Sarah Khan', 'patient_name').value).toContain('Sarah Khan')
  })

  it('fires on `Pt: <name>`', () => {
    expect(firstOf('Pt: Sarah Khan', 'patient_name').value).toContain('Sarah Khan')
  })

  it('fires on `Name: <name>`', () => {
    expect(firstOf('Name: Sarah Khan', 'patient_name').value).toContain('Sarah Khan')
  })

  it('fires on `Member: <name>`', () => {
    expect(firstOf('Member: Sarah Khan', 'patient_name').value).toContain('Sarah Khan')
  })

  it('fires on `Insured: <name>`', () => {
    expect(firstOf('Insured: Sarah Khan', 'patient_name').value).toContain('Sarah Khan')
  })

  it('fires on `Subscriber: <name>`', () => {
    expect(firstOf('Subscriber: Sarah Khan', 'patient_name').value).toContain('Sarah Khan')
  })

  it('fires on `Guarantor: <name>`', () => {
    expect(firstOf('Guarantor: Sarah Khan', 'patient_name').value).toContain('Sarah Khan')
  })

  it('fires on ALL-CAPS label `PATIENT: <name>`', () => {
    expect(firstOf('PATIENT: Sarah Khan', 'patient_name').value).toContain('Sarah Khan')
  })

  it('fires on ALL-CAPS `PATIENT NAME: <name>`', () => {
    expect(firstOf('PATIENT NAME: Sarah Khan', 'patient_name').value).toContain('Sarah Khan')
  })

  it('fires on mixed-case `paTIent: <name>`', () => {
    expect(firstOf('paTIent: Sarah Khan', 'patient_name').value).toContain('Sarah Khan')
  })
})

describe('patient_name — value shapes (positive)', () => {
  it('handles First Middle Last', () => {
    expect(firstOf('Patient: John Michael Doe', 'patient_name').value).toContain('John Michael Doe')
  })

  it('handles Last, First (comma form)', () => {
    expect(firstOf('Patient: Doe, John', 'patient_name').value).toContain('Doe, John')
  })

  it('handles Last, First Middle (comma form with middle)', () => {
    expect(firstOf('Patient: Doe, John Michael', 'patient_name').value).toContain(
      'Doe, John Michael',
    )
  })

  it('handles a hyphenated last name (Smith-Jones)', () => {
    expect(firstOf('Patient: Sarah Smith-Jones', 'patient_name').value).toContain(
      'Sarah Smith-Jones',
    )
  })

  it("handles an apostrophe (O'Brien)", () => {
    expect(firstOf("Patient: Sean O'Brien", 'patient_name').value).toContain("Sean O'Brien")
  })

  it('handles a middle initial with period (John Q. Public)', () => {
    expect(firstOf('Patient: John Q. Public', 'patient_name').value).toContain('John Q. Public')
  })
})

describe('patient_name — clean truncation', () => {
  it('does not swallow the rest of the sentence after the name', () => {
    // "Patient: Sarah Khan was seen today" — value must contain only "Sarah Khan"
    // (the anchor label is captured as part of the full labeled span, but the
    // NAME portion must not extend past the last capitalized token).
    const finding = firstOf('Patient: Sarah Khan was seen today', 'patient_name')
    expect(finding.value).toContain('Sarah Khan')
    expect(finding.value).not.toContain('was')
    expect(finding.value).not.toContain('seen')
    expect(finding.value).not.toContain('today')
  })

  it('does not extend into a lowercase follow-up word', () => {
    const finding = firstOf('Patient: John Doe reported nausea.', 'patient_name')
    expect(finding.value).toContain('John Doe')
    expect(finding.value).not.toContain('reported')
  })
})

// ─── patient_name — negative (the point of the PR) ───────────────────────────

describe('patient_name — negatives (free prose, provider labels, wrong values)', () => {
  it('does NOT fire on a bare name in free prose (no anchor)', () => {
    expect(findingsFor('Sarah Khan was admitted to the ER', 'patient_name')).toHaveLength(0)
  })

  it('does NOT fire on `Provider: Dr. Alice Wong` (provider label excluded)', () => {
    expect(findingsFor('Provider: Dr. Alice Wong', 'patient_name')).toHaveLength(0)
  })

  it('does NOT fire on `Physician: Dr. Alice Wong` (provider label excluded)', () => {
    expect(findingsFor('Physician: Dr. Alice Wong', 'patient_name')).toHaveLength(0)
  })

  it('does NOT fire on `Referring: Dr. Alice Wong` (provider label excluded)', () => {
    expect(findingsFor('Referring: Dr. Alice Wong', 'patient_name')).toHaveLength(0)
  })

  it('does NOT fire on `Dr. Alice Wong signed off` (no anchor at all)', () => {
    expect(findingsFor('Dr. Alice Wong signed off', 'patient_name')).toHaveLength(0)
  })

  it('does NOT fire on `Patient ID: 12345` (labeled but numeric value)', () => {
    // patient_id fires here; patient_name must not.
    expect(findingsFor('Patient ID: 12345', 'patient_name')).toHaveLength(0)
  })

  it('does NOT fire on a single-token value after a patient label', () => {
    expect(findingsFor('Patient: John', 'patient_name')).toHaveLength(0)
  })

  it('does NOT fire on a patient label followed by lowercase prose', () => {
    // "Patient: seen today for" — no capitalized name tokens follow the label.
    expect(findingsFor('Patient: seen today for follow-up', 'patient_name')).toHaveLength(0)
  })

  it('does NOT fire on a bare-label prefix ("the patient Sarah Khan reported")', () => {
    // No separator between `patient` and the name → helper requires `:`, `-`, `–`, or `=`.
    expect(findingsFor('the patient Sarah Khan reported', 'patient_name')).toHaveLength(0)
  })

  it('does NOT fire on `Patient: Room 400` (Room is one token, 400 is not a name)', () => {
    expect(findingsFor('Patient: Room 400', 'patient_name')).toHaveLength(0)
  })
})

// ─── street_address — positive ───────────────────────────────────────────────

describe('street_address — positive (structural and labeled)', () => {
  it('fires on `Address: 123 Main St` (label + structural)', () => {
    expect(firstOf('Address: 123 Main St', 'street_address').value).toContain('123 Main St')
  })

  it('fires on `123 Main St` (bare structural)', () => {
    expect(firstOf('123 Main St', 'street_address').value).toContain('123 Main St')
  })

  it('fires on `456 Oak Avenue Apt 2B` (structural with unit indicator)', () => {
    const value = firstOf('456 Oak Avenue Apt 2B', 'street_address').value
    expect(value).toContain('456 Oak Avenue')
    expect(value).toContain('Apt 2B')
  })

  it('fires on `789 County Road 12` (structural with trailing number)', () => {
    const value = firstOf('789 County Road 12', 'street_address').value
    expect(value).toContain('789')
    expect(value).toContain('County Road')
  })

  it('fires on `Home Address: 500 Elm Drive`', () => {
    expect(firstOf('Home Address: 500 Elm Drive', 'street_address').value).toContain(
      '500 Elm Drive',
    )
  })

  it('fires on `Addr: 45 Elm Rd`', () => {
    expect(firstOf('Addr: 45 Elm Rd', 'street_address').value).toContain('45 Elm Rd')
  })

  it('fires on ALL-CAPS label `ADDRESS: 123 Main St`', () => {
    expect(firstOf('ADDRESS: 123 Main St', 'street_address').value).toContain('123 Main St')
  })

  it('fires on ALL-CAPS `HOME ADDRESS: 500 Elm Drive`', () => {
    expect(firstOf('HOME ADDRESS: 500 Elm Drive', 'street_address').value).toContain(
      '500 Elm Drive',
    )
  })

  it('fires on a structural address embedded mid-sentence', () => {
    const value = firstOf('They live at 200 Oak Boulevard now', 'street_address').value
    expect(value).toContain('200 Oak Boulevard')
  })
})

// ─── street_address — negative (the point of the PR) ─────────────────────────

describe('street_address — negatives (no anchor, no structure)', () => {
  it('does NOT fire on `We met on Main Street` (no leading house number, no label)', () => {
    expect(findingsFor('We met on Main Street', 'street_address')).toHaveLength(0)
  })

  it('does NOT fire on `Meeting in room 400` (bare number, no street)', () => {
    expect(findingsFor('Meeting in room 400', 'street_address')).toHaveLength(0)
  })

  it('does NOT fire on `See page 42 for details`', () => {
    expect(findingsFor('See page 42 for details', 'street_address')).toHaveLength(0)
  })

  it('does NOT fire on `Main Street was closed today` (street name in prose)', () => {
    expect(findingsFor('Main Street was closed today', 'street_address')).toHaveLength(0)
  })

  it('does NOT fire on `The 123 was a lot of items` (number then lowercase prose)', () => {
    expect(findingsFor('The 123 was a lot of items', 'street_address')).toHaveLength(0)
  })

  it('does NOT fire on a bare `Address` label with no separator or value', () => {
    // Required separator prevents "Address is unavailable" from misfiring on
    // "is unavailable" as a value.
    expect(findingsFor('Address is unavailable at this time', 'street_address')).toHaveLength(0)
  })
})

// ─── mask token rendering ────────────────────────────────────────────────────

describe('mask tokens', () => {
  it('replaces patient_name with [PATIENT_NAME]', () => {
    const { text: masked } = mask('Patient: Sarah Khan', detect('Patient: Sarah Khan'))
    expect(masked).toContain('[PATIENT_NAME]')
    expect(masked).not.toContain('Sarah Khan')
  })

  it('replaces street_address with [ADDRESS]', () => {
    const input = '123 Main St'
    const { text: masked } = mask(input, detect(input))
    expect(masked).toContain('[ADDRESS]')
    expect(masked).not.toContain('123 Main St')
  })
})

// ─── combination scoring (no engine changes, but now exercised) ──────────────

describe('combination scoring — name + medication / name + DOB', () => {
  it('Name + medication → name masked, medication stays LOW/unmasked', () => {
    const text = 'Patient: Sarah Khan, metformin 500mg daily'
    const findings = detect(text)
    const name = findings.find((f) => f.ruleId === 'patient_name')
    const med = findings.find((f) => f.ruleId === 'medication')
    expect(name).toBeDefined()
    expect(med).toBeDefined()
    expect(isMaskable(name!)).toBe(true)
    expect(isMaskable(med!)).toBe(false)
    expect(med!.effectiveSensitivity).toBe(SensitivityLevel.LOW)
  })

  it('Name + DOB → both masked (both IDENTITY / HIGH)', () => {
    const text = 'Patient: Sarah Khan DOB: 01/02/1980'
    const findings = detect(text)
    const name = findings.find((f) => f.ruleId === 'patient_name')
    const dob = findings.find((f) => f.ruleId === 'date_of_birth')
    expect(name).toBeDefined()
    expect(dob).toBeDefined()
    expect(isMaskable(name!)).toBe(true)
    expect(isMaskable(dob!)).toBe(true)
  })

  it('Name + DOB + ICD-10 → name + DOB masked, ICD stays LOW/unmasked', () => {
    const text = 'Patient: Sarah Khan DOB: 01/02/1980 dx K12.9 documented'
    const findings = detect(text)
    const name = findings.find((f) => f.ruleId === 'patient_name')
    const dob = findings.find((f) => f.ruleId === 'date_of_birth')
    const icd = findings.find((f) => f.ruleId === 'icd10')
    expect(name).toBeDefined()
    expect(dob).toBeDefined()
    expect(icd).toBeDefined()
    expect(isMaskable(name!)).toBe(true)
    expect(isMaskable(dob!)).toBe(true)
    expect(isMaskable(icd!)).toBe(false)
  })
})

// ─── no-regression: 26 existing detectors unchanged ──────────────────────────

describe('no regression — PR 2 detectors still fire and stay clean', () => {
  it('still detects an SSN', () => {
    const findings = detect('SSN 123-45-6789')
    expect(findings.some((f) => f.ruleId === 'ssn')).toBe(true)
  })

  it('still detects an MRN with the correct mask token', () => {
    const input = 'Chart for MRN: 12345678 today'
    const findings = detect(input)
    const mrn = findings.find((f) => f.ruleId === 'mrn')
    expect(mrn).toBeDefined()
    const { text: masked } = mask(input, findings)
    expect(masked).toContain('[MRN]')
  })

  it('still ignores plain prose with no signal', () => {
    expect(detect('What is the capital of France?')).toEqual([])
  })
})
