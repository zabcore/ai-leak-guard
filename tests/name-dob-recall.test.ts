// V1.3.1 — name / DOB recall + precision gate.
//
// Complements the A-2 precision gate (precision-gate.test.ts). Here we
// assert the NEW recall (names/DOB that must warn) AND that it did not
// cost precision on the grown negative corpus (eponyms / orgs / places /
// departments now live permanently in precision-corpus.json). Names and
// DOB are exercised independently and together, and an independence
// check proves an MRN/SSN warning never CONCEALS a missed name/DOB.
//
// "Zero false positives" here means zero observed on THESE named
// corpora — not a universal guarantee (see the measurement note).

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { detect, detectDetailed } from '../src/detector/engine'
import { mask } from '../src/content/masker'

const corpus = JSON.parse(
  readFileSync(resolve(__dirname, 'name-dob-corpus.json'), 'utf8'),
) as Record<string, string[]>
const warns = (t: string): boolean => detectDetailed(t).hasCriticalOrHigh
const maskText = (t: string): { text: string } => mask(t, detect(t))
const ruleIds = (t: string): string[] => detect(t).map((f) => f.ruleId)
const NAME_RULES = ['patient_name', 'patient_name_labeled', 'patient_name_honorific', 'patient_name_id_adjacent']

// Non-DOB dates that must NEVER be read as a DOB.
const DOB_NEGATIVES = [
  'appointment on 03/14/2026',
  'our next quality meeting is on 11/02/2026',
  'follow-up visit set for 07/21/2026',
  'clinic will be closed 12/25/2026 for the holiday',
  'the study ran from 01/01/2020 to 12/31/2020',
  'born to run is a great album',
  'the practice was born in 2019',
  'newborn seen 01/02/2026 for jaundice',
  'stillborn protocol reviewed 01/02/2026',
  'reborn clinic reopened 01/02/2026',
  'was born and raised in Ohio',
  'DOB 13/40/1980',
  'DOB 02/30/1980',
  // Day-first parser: invalid under BOTH interpretations → reject.
  'DOB 31/04/2017',
  'DOB: 29/02/2017',
  // A day-first date with NO birth label is still just a date.
  'the meeting is on 23/12/2026',
  // Written-month: label anchoring + calendar validation still apply.
  'Appointment: Sep/20/1988',
  'DOB: 31 April 2017',
  'DOB: Foo/20/1988',
  'the seminar is in September 2026',
  'Meeting September 20, 2026',
]

describe('V1.3.1 DOB recall + precision', () => {
  it('warns on every DOB positive (born / DOB / D.O.B. / Date of Birth / Birthdate / ISO)', () => {
    const miss = corpus.positive_dob.filter((t) => !warns(t))
    expect(miss).toEqual([])
    for (const t of corpus.positive_dob) expect(ruleIds(t)).toContain('date_of_birth')
  })
  it('never reads an ordinary / invalid date as a DOB (0 FP)', () => {
    const fp = DOB_NEGATIVES.filter((t) => warns(t))
    expect(fp).toEqual([])
  })
})

describe('V1.3.1 name recall + precision', () => {
  it('warns on labeled names incl. optional-separator strong labels', () => {
    expect(corpus.positive_name_labeled.filter((t) => !warns(t))).toEqual([])
  })
  it('warns on honorific + surname', () => {
    expect(corpus.positive_name_honorific.filter((t) => !warns(t))).toEqual([])
  })
  it('warns on names adjacent to a strong identifier', () => {
    expect(corpus.positive_name_id_adjacent.filter((t) => !warns(t))).toEqual([])
  })
  it('detects a RELATIVE’s name (not suppressed to boost patient-name precision)', () => {
    // Owner regression: the mother/father/sibling name IS detected; role is
    // NOT asserted as "patient". Detection and role classification are separate.
    expect(corpus.positive_relative_name.filter((t) => !warns(t))).toEqual([])
  })
})

describe('V1.3.1 role-neutral label (Person Name, never Patient Name)', () => {
  it('every name finding uses label "Person Name" and mask "[PERSON_NAME]"', () => {
    const lines = [
      ...corpus.positive_name_labeled,
      ...corpus.positive_name_honorific,
      ...corpus.positive_name_id_adjacent,
      ...corpus.positive_relative_name,
      ...corpus.positive_together,
    ]
    for (const t of lines) {
      for (const f of detect(t)) {
        if (NAME_RULES.includes(f.ruleId)) {
          expect(f.label).toBe('Person Name')
          expect(f.maskToken).toBe('[PERSON_NAME]')
          expect(f.label).not.toBe('Patient Name')
        }
      }
    }
  })
  it('the "patient’s mother [PERSON_NAME]" example masks to a role-neutral token', () => {
    const { text: masked } = maskText(
      "Patient's mother, Mrs. Rivera, attended the visit.",
    )
    expect(masked).toContain('[PERSON_NAME]')
    expect(masked).not.toContain('[PATIENT_NAME]')
    expect(masked).not.toContain('Rivera')
  })
})

describe('V1.3.1 names + DOB together, and independence', () => {
  it('warns on combined name + DOB + identifier messages', () => {
    expect(corpus.positive_together.filter((t) => !warns(t))).toEqual([])
  })
  it('an identifier warning does NOT conceal a missed name/DOB — the name is detected on its own', () => {
    // "John Smith, MRN 12345678" must yield BOTH a name finding and the MRN.
    const idA = 'John Smith, MRN 12345678, needs a refill.'
    const ids = ruleIds(idA)
    expect(ids.some((r) => NAME_RULES.includes(r))).toBe(true)
    expect(ids).toContain('mrn')
    // Name-only (no identifier at all) still warns.
    expect(warns('Patient Name John Smith confirmed for surgery.')).toBe(true)
    // DOB-only (no identifier) still warns.
    expect(warns('born 03/12/1958')).toBe(true)
  })
})

describe('V1.3.1 precision holds on the grown negative corpus', () => {
  it('never warns on eponyms / orgs / places / departments (held-out + extra)', () => {
    const fp = [...corpus.held_out_negative].filter((t) => warns(t))
    expect(fp).toEqual([])
  })
  it('A-2 precision corpus (now grown) stays under 5% FP', () => {
    const a2 = JSON.parse(
      readFileSync(resolve(__dirname, 'precision-corpus.json'), 'utf8'),
    ) as { prompts: string[] }
    const fps = a2.prompts.filter((p) => warns(p))
    if (fps.length > 0) console.error('A-2 FPs:', fps)
    expect(fps.length / a2.prompts.length).toBeLessThan(0.05)
  })
})

describe('V1.3.1 held-out recall (reported, not tuned)', () => {
  it('reports held-out positive recall', () => {
    const hit = corpus.held_out_positive.filter((t) => warns(t))
    const miss = corpus.held_out_positive.filter((t) => !warns(t))
    console.log(`held-out positive recall: ${hit.length}/${corpus.held_out_positive.length}`)
    if (miss.length) console.log('held-out misses:', miss)
    // Held-out is a generalization signal; require a strong majority.
    expect(hit.length / corpus.held_out_positive.length).toBeGreaterThanOrEqual(0.75)
  })
})
