// V1.3 A-2 — precision gate.
//
// Turns the measured precision result into a PERMANENT CI gate so a
// future detector change can't silently regress false-positive rate.
// This MEASURES the detector; it never tunes it (no src/detector changes).
//
// The corpus (`precision-corpus.json`) is a set of CLEAN clinical prompts
// with deliberate near-misses — drug names, dosages, "Dr."/"Mr." + a
// non-patient surname, non-DOB dates, vitals/lab number-pairs, ID-shaped
// counts — none of which should trip `hasCriticalOrHigh`. It is
// EXPANDABLE: add prompts over time; never remove the near-miss coverage.
//
// A false positive = `hasCriticalOrHigh === true` on a clean prompt. The
// bar is < 5% (< 1 in 20). A second test proves the detector is still
// alive and correctly targeted (recall sanity) so "0 false positives"
// can't be gamed by a detector that simply never fires.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { detectDetailed } from '../src/detector/engine'

const corpus = JSON.parse(
  readFileSync(fileURLToPath(new URL('./precision-corpus.json', import.meta.url)), 'utf8'),
) as { note?: string; prompts: string[] }

describe('A-2 precision gate', () => {
  it('clean clinical prompts warn on < 1 in 20 (< 5%)', () => {
    const fps = corpus.prompts.filter((p) => detectDetailed(p).hasCriticalOrHigh)
    if (fps.length > 0) {
      // Print each offending prompt + its findings so a regression is
      // immediately diagnosable (category:severity per finding).
      for (const p of fps) {
        const findings = detectDetailed(p).findings.map(
          (f) => `${f.category ?? 'uncategorized'}:${f.effectiveSensitivity ?? '?'}`,
        )
        console.error(`A-2 false positive: ${JSON.stringify(p)} → ${findings.join(', ')}`)
      }
    }
    expect(fps.length / corpus.prompts.length).toBeLessThan(0.05)
    // Guard against a corpus that shrank below a meaningful size.
    expect(corpus.prompts.length).toBeGreaterThanOrEqual(40)
  })

  it('recall sanity: dirty prompts still warn', () => {
    const dirty = [
      'Patient Jane Doe, MRN 12345678, needs a medication refill.',
      'The SSN on file is 123-45-6789, please verify.',
      'Rendering provider NPI 1234567893 for the claim.',
      'New intake DOB 01/02/1980, please schedule.',
    ]
    // Every dirty prompt MUST warn — an empty array means none slipped through.
    expect(dirty.filter((p) => !detectDetailed(p).hasCriticalOrHigh)).toEqual([])
  })
})
