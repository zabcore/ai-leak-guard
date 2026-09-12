// V1.3.1 §C — the monitor's probe plan is DERIVED from the §D coverage
// definition. This suite pins that derivation (pure, no browser) so the
// monitor and coverage can never silently drift, and lives in the main
// vitest gate so a coverage change that would mis-shape the monitor fails
// here immediately.

import { describe, expect, it } from 'vitest'
import { buildMonitorPlan, browserProbeSurfaces } from '../monitor/coverage-plan'
import { COVERAGE } from '../src/shared/coverage'

const plan = buildMonitorPlan()
const byId = new Map(plan.map((p) => [p.id, p]))

describe('§C monitor plan — derived from §D coverage', () => {
  it('plans exactly the coverage surfaces', () => {
    expect(new Set(plan.map((p) => p.id))).toEqual(new Set(COVERAGE.surfaces.map((s) => s.id)))
  })

  it('turns every supported inputRoute into a positive (intervene) probe', () => {
    for (const surface of COVERAGE.surfaces) {
      const p = byId.get(surface.id)!
      const wantsPaste = surface.inputRoutes.includes('paste-text')
      const wantsSendEnter = surface.inputRoutes.includes('send-enter')
      const wantsSendButton = surface.inputRoutes.includes('send-button')
      const wantsDoc = surface.inputRoutes.some((r) => r.startsWith('file-'))
      const positives = new Set(
        p.probes.filter((x) => x.expect === 'intervene').map((x) => x.route),
      )
      expect(positives.has('paste')).toBe(wantsPaste)
      expect(positives.has('send-enter')).toBe(wantsSendEnter)
      expect(positives.has('send-button')).toBe(wantsSendButton)
      expect(positives.has('document')).toBe(wantsDoc)
    }
  })

  it('turns every unsupported flag into a negative (passthrough) probe', () => {
    for (const surface of COVERAGE.surfaces) {
      const p = byId.get(surface.id)!
      const negatives = new Set(
        p.probes.filter((x) => x.expect === 'passthrough').map((x) => x.route),
      )
      expect(negatives.has('paste')).toBe(surface.paste === 'unsupported')
      expect(negatives.has('send-enter')).toBe(surface.send === 'unsupported')
      expect(negatives.has('document')).toBe(surface.document === 'unsupported')
    }
  })

  it('records unvalidated flags but never asserts them', () => {
    // copilot-m365 paste is 'unvalidated' → recorded, never probed.
    const m365 = byId.get('copilot-m365')!
    expect(m365.unvalidated).toContain('paste')
    expect(m365.probes.some((x) => x.route === 'paste')).toBe(false)
  })

  it('never emits both a positive and a negative probe for one route', () => {
    for (const p of plan) {
      const routes = p.probes.map((x) => x.route)
      expect(new Set(routes).size).toBe(routes.length)
    }
  })
})

describe('§C monitor plan — host isolation & honesty', () => {
  it('marks M365 Copilot as not independently probeable (shares host with personal)', () => {
    expect(byId.get('copilot-m365')!.independentlyProbeable).toBe(false)
    expect(byId.get('copilot-personal')!.independentlyProbeable).toBe(true)
  })

  it('a non-independently-probeable surface makes no positive (supported) claim', () => {
    for (const p of plan) {
      if (p.independentlyProbeable) continue
      expect(p.probes.every((x) => x.expect === 'passthrough')).toBe(true)
    }
  })

  it('browserProbeSurfaces are the independently-probeable ones with probes', () => {
    const ids = browserProbeSurfaces().map((p) => p.id)
    expect(ids).toContain('chatgpt')
    expect(ids).toContain('claude')
    expect(ids).toContain('gemini')
    expect(ids).toContain('copilot-personal')
    expect(ids).toContain('perplexity')
    expect(ids).not.toContain('copilot-m365')
  })

  it('expected positive/negative shape per surface', () => {
    const positive = (id: string) =>
      new Set(
        byId
          .get(id)!
          .probes.filter((x) => x.expect === 'intervene')
          .map((x) => x.route),
      )
    const negative = (id: string) =>
      new Set(
        byId
          .get(id)!
          .probes.filter((x) => x.expect === 'passthrough')
          .map((x) => x.route),
      )

    for (const id of ['chatgpt', 'claude', 'gemini']) {
      expect(positive(id)).toEqual(new Set(['paste', 'send-enter', 'send-button', 'document']))
      expect(negative(id).size).toBe(0)
    }
    expect(positive('copilot-personal')).toEqual(new Set(['paste', 'send-enter', 'send-button']))
    expect(negative('copilot-personal')).toEqual(new Set(['document']))
    expect(positive('perplexity')).toEqual(new Set(['paste', 'document']))
    expect(negative('perplexity')).toEqual(new Set(['send-enter']))
  })
})
