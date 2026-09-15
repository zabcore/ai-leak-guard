// V1.3.3 — the guided self-test injects three independent identifier cases
// (name, MRN, DOB) rather than one combined string, so a single passing
// detection can no longer mask another silently breaking. This suite pins
// each case to the DETECTOR'S category output — not modal presence — so the
// synthetic data provably exercises the category it claims to.

import { describe, expect, it } from 'vitest'
import { SELF_TEST_CASES } from '../src/shared/self-test'
import { detectDetailed } from '../src/detector/engine'
import { DetectorCategory } from '../src/detector/types'

describe('self-test cases — each identifier fires its own category', () => {
  it('covers name, MRN, and DOB (numeric + written month) independently', () => {
    const ids = SELF_TEST_CASES.map((c) => c.id)
    expect(ids).toEqual(['name', 'mrn', 'dob-numeric', 'dob-written'])
  })

  for (const testCase of SELF_TEST_CASES) {
    it(`${testCase.id} ("${testCase.text}") → ${testCase.expectedCategory}`, () => {
      const { findings, hasCriticalOrHigh } = detectDetailed(testCase.text)
      // It must actually trip the send-warning threshold…
      expect(hasCriticalOrHigh, `${testCase.id}: expected a critical/high finding`).toBe(true)
      // …and, specifically, produce the expected category (asserting the
      // category, not merely that some warning appeared).
      const categories = findings.map((f) => f.category)
      expect(
        categories,
        `${testCase.id}: expected category ${testCase.expectedCategory}, got ${categories.join(', ') || '(none)'}`,
      ).toContain(testCase.expectedCategory)
    })
  }

  it('name is caught by the rule, not by NER — a bare name stays undetected', () => {
    // Guards the choice of an honorific+surname synthetic: on-device NER is
    // out of scope, so a bare "Jane Doe" must NOT trip (documented limitation).
    expect(detectDetailed('Jane Doe').hasCriticalOrHigh).toBe(false)
    const name = SELF_TEST_CASES.find((c) => c.id === 'name')!
    expect(name.expectedCategory).toBe(DetectorCategory.IDENTITY)
    expect(detectDetailed(name.text).hasCriticalOrHigh).toBe(true)
  })
})
