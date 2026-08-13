import { describe, expect, it } from 'vitest'
import { detect, detectDetailed, isMaskable } from '../src/detector/engine'
import { RULES } from '../src/detector/rules'
import { mask } from '../src/content/masker'
import { DetectorCategory, SensitivityLevel, type Finding } from '../src/detector/types'
import { isPlausiblePhone, isValidDea, isValidNpi } from '../src/detector/validators'

function firstOf(text: string, ruleId: string): Finding | undefined {
  return detect(text).find((f) => f.ruleId === ruleId)
}
function ruleIdsIn(text: string): string[] {
  return detect(text).map((f) => f.ruleId)
}

// ─── Group A: per-detector positive + negative (30 cases) ───────────────────

describe('IDENTITY detectors', () => {
  it('date_of_birth fires on a labeled numeric date', () => {
    expect(ruleIdsIn('Patient DOB: 05/12/1980, cleared')).toContain('date_of_birth')
  })
  it('date_of_birth does NOT fire on a bare date with no label', () => {
    expect(ruleIdsIn('The appointment is on 05/12/1980.')).not.toContain('date_of_birth')
  })

  it('phone fires on a US-format number', () => {
    expect(ruleIdsIn('Call me at (415) 555-2671')).toContain('phone')
  })
  it('phone does NOT fire on an obviously-fake all-same-digit sequence', () => {
    expect(ruleIdsIn('Ref 111-111-1111 in the log')).not.toContain('phone')
  })

  it('email fires on a standard address', () => {
    expect(ruleIdsIn('contact alice@example.com for details')).toContain('email')
  })
  it('email does NOT fire on a bare @ token with no local/domain', () => {
    expect(ruleIdsIn('follow us @acme on X')).not.toContain('email')
  })
})

describe('HEALTHCARE_PATIENT_ID detectors', () => {
  it('mrn fires on a labeled identifier', () => {
    expect(ruleIdsIn('Chart pulled for MRN: 12345678.')).toContain('mrn')
  })
  it('mrn does NOT fire on the bare identifier without the label', () => {
    expect(ruleIdsIn('The reference is 12345678 for now.')).not.toContain('mrn')
  })
  it('mrn does NOT fire on the label with no numeric identifier', () => {
    expect(ruleIdsIn('See the MRN documentation for details.')).not.toContain('mrn')
  })

  it('member_id fires on a labeled member ID', () => {
    expect(ruleIdsIn('Member ID: A1234567 verified')).toContain('member_id')
  })
  it('member_id does NOT fire without a label', () => {
    expect(ruleIdsIn('The value A1234567 is elsewhere')).not.toContain('member_id')
  })

  it('claim_number fires on a labeled claim', () => {
    expect(ruleIdsIn('Claim #: 987654321 submitted')).toContain('claim_number')
  })
  it('claim_number does NOT fire on a bare number', () => {
    expect(ruleIdsIn('Reference 987654321 in the ticket')).not.toContain('claim_number')
  })

  it('rx_number fires on a labeled Rx number', () => {
    expect(ruleIdsIn('Rx #: 456789012 refilled')).toContain('rx_number')
  })
  it('rx_number does NOT fire on Rx label followed by a dose (not an Rx number)', () => {
    expect(ruleIdsIn('Rx: 100mg twice daily')).not.toContain('rx_number')
  })

  it('patient_id fires on a labeled patient identifier', () => {
    expect(ruleIdsIn('Patient ID: P456789 in the queue')).toContain('patient_id')
  })
  it('patient_id does NOT fire without a label', () => {
    expect(ruleIdsIn('Value P456789 was recorded')).not.toContain('patient_id')
  })
})

describe('GOVERNMENT_FINANCIAL detectors (V1.1 additions)', () => {
  it('account_number fires on a labeled account', () => {
    expect(ruleIdsIn('Account #: 4567890123 debited')).toContain('account_number')
  })
  it('account_number does NOT fire on a bare digit sequence', () => {
    expect(ruleIdsIn('Reference 4567890123 exists elsewhere')).not.toContain('account_number')
  })

  it('license_number fires on a labeled DL', () => {
    expect(ruleIdsIn('License #: DL12345678 issued')).toContain('license_number')
  })
  it('license_number does NOT fire on a bare identifier without label', () => {
    expect(ruleIdsIn('The code X12345678 is unrelated')).not.toContain('license_number')
  })
})

describe('PROVIDER_ID detectors', () => {
  it('npi fires on a checksum-valid 10-digit NPI (1234567893)', () => {
    expect(ruleIdsIn('Provider NPI 1234567893 on file')).toContain('npi')
  })
  it('npi does NOT fire on a 10-digit sequence with a bad check digit (1234567890)', () => {
    expect(ruleIdsIn('Reference 1234567890 was quoted')).not.toContain('npi')
  })

  it('dea fires on a checksum-valid DEA number (AB1234563)', () => {
    expect(ruleIdsIn('DEA registration AB1234563 verified')).toContain('dea')
  })
  it('dea does NOT fire on a DEA-shaped string with a bad checksum', () => {
    expect(ruleIdsIn('The string AB1234567 in the log')).not.toContain('dea')
  })
})

describe('CLINICAL_CONTEXT detectors', () => {
  it('icd10 fires on a canonical ICD-10 code', () => {
    expect(ruleIdsIn('Coded diagnosis K12.9 in note')).toContain('icd10')
  })
  it('icd10 does NOT fire on a plain 5-digit sequence with no letter prefix', () => {
    expect(ruleIdsIn('Ref number 12345 was logged')).not.toContain('icd10')
  })

  it('cpt fires on a labeled 5-digit CPT code', () => {
    expect(ruleIdsIn('CPT: 99213 billed today')).toContain('cpt')
  })
  it('cpt does NOT fire on a bare 5-digit sequence with no CPT label', () => {
    expect(ruleIdsIn('Zip code 99213 is where they live')).not.toContain('cpt')
  })

  it('medication fires on a dictionary word (case-insensitive)', () => {
    expect(ruleIdsIn('Prescribed Metformin daily')).toContain('medication')
  })
  it('medication does NOT fire on a non-drug English word', () => {
    expect(ruleIdsIn('The patient is comfortable')).not.toContain('medication')
  })
})

// ─── Group B: validator unit tests ──────────────────────────────────────────

describe('isValidNpi', () => {
  it('accepts a known-valid NPI', () => {
    expect(isValidNpi('1234567893')).toBe(true)
  })
  it('rejects a wrong-check-digit NPI', () => {
    expect(isValidNpi('1234567890')).toBe(false)
  })
  it('rejects a non-10-digit input', () => {
    expect(isValidNpi('123456789')).toBe(false)
    expect(isValidNpi('12345678901')).toBe(false)
    expect(isValidNpi('123456789A')).toBe(false)
  })
})

describe('isValidDea', () => {
  it('accepts a checksum-valid DEA number', () => {
    expect(isValidDea('AB1234563')).toBe(true)
  })
  it('rejects a checksum-invalid DEA-shaped string', () => {
    expect(isValidDea('AB1234567')).toBe(false)
  })
  it('rejects a first letter not on the registrant-type list', () => {
    expect(isValidDea('YZ1234563')).toBe(false)
  })
  it('rejects a wrong-length input', () => {
    expect(isValidDea('AB12345')).toBe(false)
    expect(isValidDea('AB123456789')).toBe(false)
    expect(isValidDea('123456789')).toBe(false)
  })
})

describe('isPlausiblePhone', () => {
  it('accepts a normal 10-digit US phone', () => {
    expect(isPlausiblePhone('(415) 555-2671')).toBe(true)
  })
  it('accepts an international number of up to 15 digits', () => {
    expect(isPlausiblePhone('+44 20 7946 0958')).toBe(true)
  })
  it('rejects an all-same-digit sequence', () => {
    expect(isPlausiblePhone('111-111-1111')).toBe(false)
    expect(isPlausiblePhone('0000000000')).toBe(false)
  })
  it('rejects too-short and too-long sequences', () => {
    expect(isPlausiblePhone('123456')).toBe(false)
    expect(isPlausiblePhone('1234567890123456')).toBe(false)
  })
})

// ─── Group C: combination scoring (integrated) ──────────────────────────────

describe('combination scoring — clinical context is LOW and not masked', () => {
  it('ICD-10 alone → LOW, not maskable', () => {
    const icd = firstOf('Coded diagnosis K12.9 in note', 'icd10')
    expect(icd?.effectiveSensitivity).toBe(SensitivityLevel.LOW)
    expect(isMaskable(icd!)).toBe(false)
  })

  it('CPT (labeled) alone → LOW, not maskable', () => {
    const cpt = firstOf('CPT: 99213 billed today', 'cpt')
    expect(cpt?.effectiveSensitivity).toBe(SensitivityLevel.LOW)
    expect(isMaskable(cpt!)).toBe(false)
  })

  it('medication alone → LOW, not maskable', () => {
    const med = firstOf('Prescribed metformin daily', 'medication')
    expect(med?.effectiveSensitivity).toBe(SensitivityLevel.LOW)
    expect(isMaskable(med!)).toBe(false)
  })

  it('MRN + ICD-10 in one paste — MRN is CRITICAL/maskable, ICD stays LOW/unmasked', () => {
    const findings = detect('Chart pulled for MRN: 12345678 with diagnosis K12.9.')
    const mrn = findings.find((f) => f.ruleId === 'mrn')
    const icd = findings.find((f) => f.ruleId === 'icd10')
    expect(mrn?.effectiveSensitivity).toBe(SensitivityLevel.CRITICAL)
    expect(icd?.effectiveSensitivity).toBe(SensitivityLevel.LOW)
    expect(isMaskable(mrn!)).toBe(true)
    expect(isMaskable(icd!)).toBe(false)
  })

  it('detectDetailed on MRN + ICD → hasCriticalOrHigh true, both findings present', () => {
    const { findings, hasCriticalOrHigh } = detectDetailed(
      'Chart pulled for MRN: 12345678 with diagnosis K12.9.',
    )
    expect(hasCriticalOrHigh).toBe(true)
    const ids = new Set(findings.map((f) => f.ruleId))
    expect(ids.has('mrn')).toBe(true)
    expect(ids.has('icd10')).toBe(true)
  })

  it('detectDetailed on medication-only prose → hasCriticalOrHigh false', () => {
    const { findings, hasCriticalOrHigh } = detectDetailed('Prescribed metformin daily.')
    expect(hasCriticalOrHigh).toBe(false)
    expect(findings.length).toBeGreaterThan(0)
    expect(findings.every((f) => !isMaskable(f))).toBe(true)
  })

  it('no CLINICAL_CONTEXT finding is ever promoted above LOW', () => {
    const findings = detect(
      'Chart for MRN: 12345678, DOB: 05/12/1980, diagnosis K12.9, CPT: 99213, prescribed metformin.',
    )
    for (const f of findings) {
      if (f.category === DetectorCategory.CLINICAL_CONTEXT) {
        expect(f.effectiveSensitivity).toBe(SensitivityLevel.LOW)
      }
    }
  })
})

// ─── Group D: no regression + wiring ────────────────────────────────────────

describe('no regression on the V1 detectors', () => {
  it('AWS access key still fires and is maskable', () => {
    const f = firstOf('a key AKIAIOSFODNN7EXAMPLE here', 'aws_access_key')
    expect(f?.effectiveSensitivity).toBe(SensitivityLevel.CRITICAL)
    expect(isMaskable(f!)).toBe(true)
  })

  it('SSN still fires with the exclusion rules intact', () => {
    expect(ruleIdsIn('John Smith SSN 123-45-6789')).toContain('ssn')
    expect(ruleIdsIn('John Smith SSN 000-12-3456')).not.toContain('ssn')
  })

  it('RULES now has the 11 V1 detectors plus 15 V1.1 additions = 26 total', () => {
    expect(RULES).toHaveLength(26)
  })
})

describe('mask() honors an explicit maskToken', () => {
  it('uses [MRN] for the mrn rule instead of [MRN] derived from label', () => {
    const findings = detect('Chart for MRN: 12345678 today.')
    const mrnOnly = findings.filter((f) => f.ruleId === 'mrn')
    const result = mask('Chart for MRN: 12345678 today.', mrnOnly)
    expect(result.text).toBe('Chart for [MRN] today.')
    expect(result.maskedSegments[0].placeholder).toBe('[MRN]')
  })

  it('uses [DOB] for the date_of_birth rule (shorter than label-derived form)', () => {
    const findings = detect('Patient DOB: 05/12/1980.')
    const dobOnly = findings.filter((f) => f.ruleId === 'date_of_birth')
    const result = mask('Patient DOB: 05/12/1980.', dobOnly)
    expect(result.text).toBe('Patient [DOB].')
  })

  it('still uses label-derived placeholders for V1 rules with no maskToken', () => {
    const findings = detect('SSN 123-45-6789 here')
    const ssnOnly = findings.filter((f) => f.ruleId === 'ssn')
    const result = mask('SSN 123-45-6789 here', ssnOnly)
    expect(result.text).toBe('SSN [US_SOCIAL_SECURITY_NUMBER] here')
  })
})
