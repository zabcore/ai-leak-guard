import { describe, it, expect } from 'vitest'
import {
  applyCombinationScoring,
  detect,
  detectDetailed,
  hasCriticalOrHigh,
  isMaskable,
} from '../src/detector/engine'
import { RULES } from '../src/detector/rules'
import {
  DetectorCategory,
  SensitivityLevel,
  type DetectorCategory as Category,
  type Finding,
} from '../src/detector/types'

const CATEGORIES = new Set<Category>(Object.values(DetectorCategory))
const SENSITIVITIES = new Set(Object.values(SensitivityLevel))

function findingFor(ruleId: string, text: string): Finding {
  const match = detect(text).find((f) => f.ruleId === ruleId)
  if (match === undefined) throw new Error(`no finding for rule ${ruleId} in text: ${text}`)
  return match
}

function synthetic(
  ruleId: string,
  category: DetectorCategory,
  baseSensitivity: SensitivityLevel,
): Finding {
  return {
    ruleId,
    label: ruleId,
    severity: 'high',
    start: 0,
    end: 1,
    value: 'x',
    category,
    baseSensitivity,
    isContextSignal: category === DetectorCategory.CLINICAL_CONTEXT,
  }
}

// ─── Group B: taxonomy assignment ────────────────────────────────────────────

describe('RULES taxonomy', () => {
  it('gives every rule a valid category', () => {
    for (const rule of RULES) {
      expect(CATEGORIES.has(rule.category)).toBe(true)
    }
  })

  it('gives every rule a valid baseSensitivity', () => {
    for (const rule of RULES) {
      expect(SENSITIVITIES.has(rule.baseSensitivity)).toBe(true)
    }
  })

  it('matches the expected category/baseSensitivity table (snapshot)', () => {
    const table = Object.fromEntries(
      RULES.map((r) => [r.id, { category: r.category, baseSensitivity: r.baseSensitivity }]),
    )
    expect(table).toEqual({
      // V1 detectors
      aws_access_key: { category: 'developer_credential', baseSensitivity: 'critical' },
      github_pat: { category: 'developer_credential', baseSensitivity: 'critical' },
      anthropic_key: { category: 'developer_credential', baseSensitivity: 'critical' },
      openai_key: { category: 'developer_credential', baseSensitivity: 'critical' },
      stripe_key: { category: 'developer_credential', baseSensitivity: 'critical' },
      google_api_key: { category: 'developer_credential', baseSensitivity: 'critical' },
      jwt: { category: 'developer_credential', baseSensitivity: 'high' },
      private_key_block: { category: 'developer_credential', baseSensitivity: 'critical' },
      ssn: { category: 'government_financial', baseSensitivity: 'critical' },
      credit_card: { category: 'government_financial', baseSensitivity: 'critical' },
      generic_secret: { category: 'developer_credential', baseSensitivity: 'high' },
      // V1.1 PR 2 — PROVIDER_ID
      npi: { category: 'provider_id', baseSensitivity: 'high' },
      dea: { category: 'provider_id', baseSensitivity: 'high' },
      // V1.1 PR 2 — IDENTITY
      date_of_birth: { category: 'identity', baseSensitivity: 'high' },
      phone: { category: 'identity', baseSensitivity: 'high' },
      email: { category: 'identity', baseSensitivity: 'high' },
      // V1.1 PR 2 — HEALTHCARE_PATIENT_ID
      mrn: { category: 'healthcare_patient_id', baseSensitivity: 'critical' },
      member_id: { category: 'healthcare_patient_id', baseSensitivity: 'high' },
      claim_number: { category: 'healthcare_patient_id', baseSensitivity: 'high' },
      rx_number: { category: 'healthcare_patient_id', baseSensitivity: 'high' },
      patient_id: { category: 'healthcare_patient_id', baseSensitivity: 'high' },
      // V1.1 PR 2 — GOVERNMENT_FINANCIAL (additions)
      account_number: { category: 'government_financial', baseSensitivity: 'high' },
      license_number: { category: 'government_financial', baseSensitivity: 'high' },
      // V1.1 PR 2 — CLINICAL_CONTEXT
      icd10: { category: 'clinical_context', baseSensitivity: 'low' },
      cpt: { category: 'clinical_context', baseSensitivity: 'low' },
      medication: { category: 'clinical_context', baseSensitivity: 'low' },
      // V1.1 PR 3 — IDENTITY (names + addresses)
      patient_name: { category: 'identity', baseSensitivity: 'high' },
      street_address: { category: 'identity', baseSensitivity: 'high' },
    })
  })
})

describe('detect() enriches findings with taxonomy', () => {
  it('carries category + baseSensitivity on an AWS finding', () => {
    const finding = findingFor('aws_access_key', 'a key AKIAIOSFODNN7EXAMPLE here')
    expect(finding.category).toBe(DetectorCategory.DEVELOPER_CREDENTIAL)
    expect(finding.baseSensitivity).toBe(SensitivityLevel.CRITICAL)
  })

  it('categorizes SSN as GOVERNMENT_FINANCIAL / CRITICAL', () => {
    const finding = findingFor('ssn', 'John Smith SSN 123-45-6789')
    expect(finding.category).toBe(DetectorCategory.GOVERNMENT_FINANCIAL)
    expect(finding.baseSensitivity).toBe(SensitivityLevel.CRITICAL)
  })

  it('categorizes a Luhn-valid credit card as GOVERNMENT_FINANCIAL / CRITICAL', () => {
    const finding = findingFor('credit_card', 'Card: 4532015112830366')
    expect(finding.category).toBe(DetectorCategory.GOVERNMENT_FINANCIAL)
    expect(finding.baseSensitivity).toBe(SensitivityLevel.CRITICAL)
  })

  it('categorizes JWT as DEVELOPER_CREDENTIAL / HIGH', () => {
    const finding = findingFor(
      'jwt',
      'auth eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123def456ghi789 here',
    )
    expect(finding.category).toBe(DetectorCategory.DEVELOPER_CREDENTIAL)
    expect(finding.baseSensitivity).toBe(SensitivityLevel.HIGH)
  })

  it('categorizes generic_secret as DEVELOPER_CREDENTIAL / HIGH', () => {
    const finding = findingFor('generic_secret', 'api_key = "aB3xK9mP2qR7sT1vW5yZ8nC4"')
    expect(finding.category).toBe(DetectorCategory.DEVELOPER_CREDENTIAL)
    expect(finding.baseSensitivity).toBe(SensitivityLevel.HIGH)
  })
})

// ─── Group C: applyCombinationScoring computes effectiveSensitivity ─────────

describe('applyCombinationScoring — Rule A (non-context keeps baseSensitivity)', () => {
  it('SSN alone → effectiveSensitivity = CRITICAL', () => {
    const finding = findingFor('ssn', 'John Smith SSN 123-45-6789')
    expect(finding.effectiveSensitivity).toBe(SensitivityLevel.CRITICAL)
  })

  it('AWS key alone → effectiveSensitivity = CRITICAL', () => {
    const finding = findingFor('aws_access_key', 'a key AKIAIOSFODNN7EXAMPLE here')
    expect(finding.effectiveSensitivity).toBe(SensitivityLevel.CRITICAL)
  })

  it('credit card alone → effectiveSensitivity = CRITICAL', () => {
    const finding = findingFor('credit_card', 'Card: 4532015112830366')
    expect(finding.effectiveSensitivity).toBe(SensitivityLevel.CRITICAL)
  })

  it('generic_secret alone → effectiveSensitivity = HIGH', () => {
    const finding = findingFor('generic_secret', 'api_key = "aB3xK9mP2qR7sT1vW5yZ8nC4"')
    expect(finding.effectiveSensitivity).toBe(SensitivityLevel.HIGH)
  })

  it('is idempotent: running twice keeps the same effectiveSensitivity', () => {
    const once = applyCombinationScoring([
      synthetic('a', DetectorCategory.GOVERNMENT_FINANCIAL, SensitivityLevel.CRITICAL),
    ])
    const twice = applyCombinationScoring(once)
    expect(twice).toEqual(once)
  })
})

describe('applyCombinationScoring — Rule B/C (CLINICAL_CONTEXT is always LOW in V1.1)', () => {
  it('clinical context alone → effectiveSensitivity = LOW', () => {
    const [scored] = applyCombinationScoring([
      synthetic('ctx', DetectorCategory.CLINICAL_CONTEXT, SensitivityLevel.HIGH),
    ])
    expect(scored.effectiveSensitivity).toBe(SensitivityLevel.LOW)
  })

  it('clinical context alongside an IDENTITY finding → context stays LOW', () => {
    const scored = applyCombinationScoring([
      synthetic('id', DetectorCategory.IDENTITY, SensitivityLevel.CRITICAL),
      synthetic('ctx', DetectorCategory.CLINICAL_CONTEXT, SensitivityLevel.HIGH),
    ])
    expect(scored.find((f) => f.ruleId === 'ctx')?.effectiveSensitivity).toBe(SensitivityLevel.LOW)
    expect(scored.find((f) => f.ruleId === 'id')?.effectiveSensitivity).toBe(
      SensitivityLevel.CRITICAL,
    )
  })

  it('clinical context alongside only GOVERNMENT_FINANCIAL → context stays LOW', () => {
    const scored = applyCombinationScoring([
      synthetic('ssn', DetectorCategory.GOVERNMENT_FINANCIAL, SensitivityLevel.CRITICAL),
      synthetic('ctx', DetectorCategory.CLINICAL_CONTEXT, SensitivityLevel.HIGH),
    ])
    expect(scored.find((f) => f.ruleId === 'ctx')?.effectiveSensitivity).toBe(SensitivityLevel.LOW)
  })

  it('leaves bare findings (no baseSensitivity) unchanged', () => {
    const bare: Finding = {
      ruleId: 'legacy',
      label: 'Legacy',
      severity: 'high',
      start: 0,
      end: 1,
      value: 'x',
    }
    const [out] = applyCombinationScoring([bare])
    expect(out.effectiveSensitivity).toBeUndefined()
  })
})

// ─── PR 2 — activated now that real healthcare detectors exist ───────────────
// (Patient names are still deferred to PR 3, so the original placeholder title
// is scoped down to DOB as the identifier here. MRN + medication ships in PR 2
// and is exercised as-is.)

describe('PR 2 — combination scoring with real clinical detectors', () => {
  it('DOB + ICD-10 (clinical context) — identifier stays HIGH, context stays LOW', () => {
    const findings = detect('Patient DOB: 05/12/1980 with diagnosis K12.9 documented.')
    const dob = findings.find((f) => f.ruleId === 'date_of_birth')
    const icd = findings.find((f) => f.ruleId === 'icd10')
    expect(dob?.effectiveSensitivity).toBe(SensitivityLevel.HIGH)
    expect(icd?.effectiveSensitivity).toBe(SensitivityLevel.LOW)
    expect(isMaskable(dob!)).toBe(true)
    expect(isMaskable(icd!)).toBe(false)
  })

  it('MRN + medication — MRN masked, medication stays visible', () => {
    const findings = detect('Chart for MRN: 12345678 prescribed metformin daily.')
    const mrn = findings.find((f) => f.ruleId === 'mrn')
    const med = findings.find((f) => f.ruleId === 'medication')
    expect(mrn).toBeDefined()
    expect(med).toBeDefined()
    expect(isMaskable(mrn!)).toBe(true)
    expect(isMaskable(med!)).toBe(false)
  })
})

// ─── Group D: hasCriticalOrHigh / detectDetailed / isMaskable ───────────────

describe('hasCriticalOrHigh + detectDetailed', () => {
  it('detectDetailed on text with an SSN → hasCriticalOrHigh is true', () => {
    const result = detectDetailed('Their SSN is 123-45-6789')
    expect(result.hasCriticalOrHigh).toBe(true)
    expect(result.findings.length).toBeGreaterThan(0)
  })

  it('detectDetailed on plain prose → empty findings, hasCriticalOrHigh false', () => {
    const result = detectDetailed('What is the capital of France?')
    expect(result.findings).toEqual([])
    expect(result.hasCriticalOrHigh).toBe(false)
  })

  it('hasCriticalOrHigh is false when the only findings are LOW', () => {
    const findings = applyCombinationScoring([
      synthetic('ctx', DetectorCategory.CLINICAL_CONTEXT, SensitivityLevel.HIGH),
    ])
    expect(hasCriticalOrHigh(findings)).toBe(false)
  })

  it('hasCriticalOrHigh is true for a mix of LOW and HIGH findings', () => {
    const findings = applyCombinationScoring([
      synthetic('ctx', DetectorCategory.CLINICAL_CONTEXT, SensitivityLevel.HIGH),
      synthetic('key', DetectorCategory.DEVELOPER_CREDENTIAL, SensitivityLevel.HIGH),
    ])
    expect(hasCriticalOrHigh(findings)).toBe(true)
  })
})

describe('isMaskable', () => {
  it('masks CRITICAL and HIGH findings', () => {
    const critical = { ...synthetic('a', DetectorCategory.IDENTITY, SensitivityLevel.CRITICAL) }
    critical.effectiveSensitivity = SensitivityLevel.CRITICAL
    const high = { ...synthetic('b', DetectorCategory.IDENTITY, SensitivityLevel.HIGH) }
    high.effectiveSensitivity = SensitivityLevel.HIGH
    expect(isMaskable(critical)).toBe(true)
    expect(isMaskable(high)).toBe(true)
  })

  it('does not mask LOW findings', () => {
    const low = { ...synthetic('c', DetectorCategory.CLINICAL_CONTEXT, SensitivityLevel.LOW) }
    low.effectiveSensitivity = SensitivityLevel.LOW
    expect(isMaskable(low)).toBe(false)
  })

  it('masks by default when a finding has no taxonomy (backward compat)', () => {
    const bare: Finding = {
      ruleId: 'legacy',
      label: 'Legacy',
      severity: 'high',
      start: 0,
      end: 1,
      value: 'x',
    }
    expect(isMaskable(bare)).toBe(true)
  })

  it('every current RULES-derived finding remains maskable (no-behavior-change guard)', () => {
    const sample =
      'SSN 123-45-6789 and AWS AKIAIOSFODNN7EXAMPLE and card 4532015112830366 and ' +
      'api_key = "aB3xK9mP2qR7sT1vW5yZ8nC4" and token ghp_abcdefghijklmnopqrstuvwxyz0123456789'
    const findings = detect(sample)
    expect(findings.length).toBeGreaterThan(0)
    for (const finding of findings) {
      expect(isMaskable(finding)).toBe(true)
    }
  })
})
