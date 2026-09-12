// V1.3.1 §Growth Loop — persistence: metadata-only projection + round trip.
// Uses the in-memory chrome.storage.local shim from tests/setup.ts.

import { describe, expect, it } from 'vitest'
import {
  GROWTH_KEY,
  defaultGrowthState,
  projectGrowthState,
  readGrowthState,
  recordProblemReport,
  writeGrowthState,
} from '../src/growth/store'
import type { GrowthState } from '../src/growth/types'

const ALLOWED_KEYS = [
  'installDate',
  'firstEligibleAt',
  'lastShownAt',
  'dismissCount',
  'dismissedUntil',
  'reviewClicked',
  'shareClicked',
  'permanentlySuppressed',
  'lastProblemReportAt',
].sort()

describe('projectGrowthState — metadata-only choke point', () => {
  it('keeps exactly the nine allowed fields and drops everything else', () => {
    const hostile = {
      installDate: 123,
      dismissCount: 2,
      reviewClicked: true,
      // stray / hostile fields that must NEVER survive:
      value: '123-45-6789',
      filename: 'patients.xlsx',
      text: 'Patient MRN 42',
      promptText: 'DOB 01/02/1980',
      __proto__: { polluted: true },
      site: 'chatgpt',
    }
    const out = projectGrowthState(hostile)
    expect(Object.keys(out).sort()).toEqual(ALLOWED_KEYS)
    const serialized = JSON.stringify(out)
    expect(serialized).not.toContain('123-45-6789')
    expect(serialized).not.toContain('patients.xlsx')
    expect(serialized).not.toContain('Patient MRN 42')
    expect(serialized).not.toContain('01/02/1980')
  })

  it('coerces bad types to safe defaults', () => {
    const out = projectGrowthState({
      installDate: 'nope',
      dismissCount: -5,
      dismissedUntil: 0,
      reviewClicked: 'yes',
    } as unknown)
    expect(out.installDate).toBe(0)
    expect(out.dismissCount).toBe(0)
    expect(out.dismissedUntil).toBeNull()
    expect(out.reviewClicked).toBe(false)
  })

  it('projects null / non-object to the default shape', () => {
    expect(projectGrowthState(null)).toEqual(defaultGrowthState())
    expect(projectGrowthState(undefined)).toEqual(defaultGrowthState())
    expect(projectGrowthState(42)).toEqual(defaultGrowthState())
  })
})

describe('read/write round trip', () => {
  it('reads defaults on a fresh install', async () => {
    expect(await readGrowthState()).toEqual(defaultGrowthState())
  })

  it('persists and reads back a full state', async () => {
    const state: GrowthState = {
      installDate: 1000,
      firstEligibleAt: 2000,
      lastShownAt: 3000,
      dismissCount: 1,
      dismissedUntil: 4000,
      reviewClicked: true,
      shareClicked: true,
      permanentlySuppressed: false,
      lastProblemReportAt: 5000,
    }
    await writeGrowthState(state)
    expect(await readGrowthState()).toEqual(state)
  })

  it('stores only projected metadata even if a stray field is passed', async () => {
    await writeGrowthState({
      ...defaultGrowthState(),
      installDate: 10,
      value: 'SSN 123-45-6789',
    } as unknown as GrowthState)
    const raw = await chrome.storage.local.get(GROWTH_KEY)
    expect(JSON.stringify(raw[GROWTH_KEY])).not.toContain('123-45-6789')
    expect('value' in (raw[GROWTH_KEY] as Record<string, unknown>)).toBe(false)
  })
})

describe('recordProblemReport', () => {
  it('sets lastProblemReportAt without disturbing other fields', async () => {
    await writeGrowthState({ ...defaultGrowthState(), installDate: 999, dismissCount: 1 })
    await recordProblemReport(77_000)
    const s = await readGrowthState()
    expect(s.lastProblemReportAt).toBe(77_000)
    expect(s.installDate).toBe(999)
    expect(s.dismissCount).toBe(1)
  })
})
