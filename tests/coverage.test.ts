// V1.3.1 §D — the coverage definition + its consumers.
//
// Asserts the file is well-formed, that every flag matches the shipped
// per-surface reality, that a public "supported" claim maps to a real
// entry backed by a manifest origin, and that the self-test consumer
// READS its surface ids from this file (single source of truth).

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  COVERAGE,
  COVERAGE_SURFACE_IDS,
  getSurfaceCoverage,
  surfaceSupports,
  type SupportState,
  type SendMode,
} from '../src/shared/coverage'
import { SELF_TEST_SITES } from '../src/shared/self-test-report'

const SUPPORT: readonly SupportState[] = ['supported', 'unsupported', 'unvalidated']
const DOC: readonly SupportState[] = ['supported', 'unsupported']
const SEND_MODES: readonly SendMode[] = ['resume', 'no-resume-two-press', null]
const ROUTES = new Set([
  'paste-text',
  'file-change',
  'file-drop',
  'file-paste',
  'file-picker',
  'send-enter',
  'send-button',
])

const manifest = JSON.parse(readFileSync(resolve('manifest.json'), 'utf8')) as {
  host_permissions: string[]
}

describe('§D coverage — well-formed', () => {
  it('has a numeric coverageVersion and a semver appliesInVersion', () => {
    expect(typeof COVERAGE.coverageVersion).toBe('number')
    expect(COVERAGE.coverageVersion).toBeGreaterThanOrEqual(1)
    expect(COVERAGE.appliesInVersion).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('is deep-frozen (immutable, packaged, not remote)', () => {
    expect(Object.isFrozen(COVERAGE)).toBe(true)
    expect(Object.isFrozen(COVERAGE.surfaces)).toBe(true)
    expect(Object.isFrozen(COVERAGE.surfaces[0])).toBe(true)
    expect(Object.isFrozen(COVERAGE.detection)).toBe(true)
  })

  it('every surface is structurally valid with a unique id and manifest-backed origins', () => {
    const ids = new Set<string>()
    for (const s of COVERAGE.surfaces) {
      expect(s.id).toMatch(/^[a-z0-9-]+$/)
      expect(ids.has(s.id)).toBe(false)
      ids.add(s.id)
      expect(s.label.length).toBeGreaterThan(0)
      expect(s.origins.length).toBeGreaterThan(0)
      expect(SUPPORT).toContain(s.paste)
      expect(SUPPORT).toContain(s.send)
      expect(DOC).toContain(s.document)
      expect(SEND_MODES).toContain(s.sendMode)
      for (const r of s.inputRoutes) expect(ROUTES.has(r)).toBe(true)
      expect(s.appliesInVersion).toBe(COVERAGE.appliesInVersion)
      // Every declared origin must be granted by the manifest — coverage
      // can't claim a surface the extension isn't allowed to run on.
      for (const o of s.origins) expect(manifest.host_permissions).toContain(o)
    }
  })

  it('sendMode is consistent with the send flag', () => {
    for (const s of COVERAGE.surfaces) {
      if (s.send === 'supported') expect(s.sendMode).not.toBeNull()
      else expect(s.sendMode).toBeNull()
    }
  })

  it('send/document/paste routes are only listed when the matching flag is supported', () => {
    for (const s of COVERAGE.surfaces) {
      const hasSend = s.inputRoutes.some((r) => r === 'send-enter' || r === 'send-button')
      const hasFile = s.inputRoutes.some((r) => r.startsWith('file-'))
      const hasPaste = s.inputRoutes.includes('paste-text')
      if (hasSend) expect(s.send).toBe('supported')
      if (hasFile) expect(s.document).toBe('supported')
      if (hasPaste) expect(s.paste).toBe('supported')
    }
  })
})

describe('§D coverage — per-surface flags match shipped reality', () => {
  const expected: Record<
    string,
    { paste: SupportState; send: SupportState; sendMode: SendMode; document: SupportState }
  > = {
    chatgpt: { paste: 'supported', send: 'supported', sendMode: 'resume', document: 'supported' },
    claude: { paste: 'supported', send: 'supported', sendMode: 'resume', document: 'supported' },
    gemini: { paste: 'supported', send: 'supported', sendMode: 'resume', document: 'supported' },
    'copilot-personal': {
      paste: 'supported',
      send: 'supported',
      sendMode: 'no-resume-two-press',
      document: 'unsupported',
    },
    'copilot-m365': {
      paste: 'unvalidated',
      send: 'unsupported',
      sendMode: null,
      document: 'unsupported',
    },
    perplexity: {
      paste: 'supported',
      send: 'unsupported',
      sendMode: null,
      document: 'supported',
    },
  }

  it('encodes exactly the expected surfaces', () => {
    expect(new Set(COVERAGE_SURFACE_IDS)).toEqual(new Set(Object.keys(expected)))
  })

  for (const [id, want] of Object.entries(expected)) {
    it(`${id}: ${want.paste} paste / ${want.send} send (${want.sendMode}) / ${want.document} document`, () => {
      const s = getSurfaceCoverage(id)
      expect(s).toBeDefined()
      expect(s!.paste).toBe(want.paste)
      expect(s!.send).toBe(want.send)
      expect(s!.sendMode).toBe(want.sendMode)
      expect(s!.document).toBe(want.document)
    })
  }

  it('personal and M365 Copilot are SEPARATE entries; NEITHER claims document coverage', () => {
    expect(getSurfaceCoverage('copilot-personal')).toBeDefined()
    expect(getSurfaceCoverage('copilot-m365')).toBeDefined()
    expect(getSurfaceCoverage('copilot-personal')!.document).toBe('unsupported')
    expect(getSurfaceCoverage('copilot-m365')!.document).toBe('unsupported')
    expect(surfaceSupports('copilot-personal', 'document')).toBe(false)
    expect(surfaceSupports('copilot-m365', 'document')).toBe(false)
  })
})

describe('§D detection block', () => {
  it('names are role-neutral Person Name / [PERSON_NAME] and free-prose NER is out of scope', () => {
    expect(COVERAGE.detection.names.label).toBe('Person Name')
    expect(COVERAGE.detection.names.maskToken).toBe('[PERSON_NAME]')
    expect(COVERAGE.detection.names.caughtWhen.length).toBeGreaterThanOrEqual(3)
    expect(COVERAGE.detection.names.notCaught.join(' ').toLowerCase()).toContain('bare name')
  })
  it('DOB is labelled-only across numeric/ISO/written-month, unlabelled excluded', () => {
    expect(COVERAGE.detection.dob.label).toBe('Date of Birth')
    expect(COVERAGE.detection.dob.maskToken).toBe('[DOB]')
    expect(COVERAGE.detection.dob.formats.length).toBeGreaterThanOrEqual(3)
    expect(COVERAGE.detection.dob.notCaught.join(' ').toLowerCase()).toContain('unlabelled')
  })
})

describe('§D consumers read from the file', () => {
  it('the self-test site allowlist IS the coverage surface ids (single source of truth)', () => {
    expect([...SELF_TEST_SITES]).toEqual([...COVERAGE_SURFACE_IDS])
  })

  it('a public "supported" claim always maps to a coverage entry', () => {
    // surfaceSupports is false for an unknown id and reflects the flag.
    expect(surfaceSupports('chatgpt', 'send')).toBe(true)
    expect(surfaceSupports('perplexity', 'send')).toBe(false)
    expect(surfaceSupports('not-a-surface', 'paste')).toBe(false)
  })
})
