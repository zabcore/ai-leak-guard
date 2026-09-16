// V1.3.3 Live Gate C — "no composer" must NOT auto-file as environment. It is
// ENV_AUTH_FAILURE only with real evidence (a nav/network error or a detected
// challenge/interstitial/login marker); otherwise it is UNCLASSIFIED and must
// be diagnosed. Pure unit coverage of the classifier.

import { describe, expect, it } from 'vitest'
import { classifyNoComposer } from '../monitor/probes'

describe('classifyNoComposer', () => {
  it('a navigation/network error → ENV_AUTH_FAILURE', () => {
    const out = classifyNoComposer({ navError: true, envMarker: null })
    expect(out.result).toBe('ENV_AUTH_FAILURE')
    expect(out.detail).toMatch(/network|navigation/i)
  })

  it('a detected env marker (challenge/interstitial) → ENV_AUTH_FAILURE naming it', () => {
    const out = classifyNoComposer({ navError: false, envMarker: 'cloudflare-challenge' })
    expect(out.result).toBe('ENV_AUTH_FAILURE')
    expect(out.detail).toContain('cloudflare-challenge')
  })

  it('a Turnstile challenge marker → ENV_AUTH_FAILURE', () => {
    const out = classifyNoComposer({ navError: false, envMarker: 'turnstile' })
    expect(out.result).toBe('ENV_AUTH_FAILURE')
    expect(out.detail).toContain('turnstile')
  })

  it('a bot-mitigation HTTP status (403 / 429) → ENV_AUTH_FAILURE', () => {
    for (const status of [403, 429] as const) {
      const out = classifyNoComposer({ navError: false, status, envMarker: null })
      expect(out.result).toBe('ENV_AUTH_FAILURE')
      expect(out.detail).toContain(String(status))
    }
  })

  it('a cf-mitigated response header → ENV_AUTH_FAILURE', () => {
    const out = classifyNoComposer({ navError: false, cfMitigated: true, envMarker: null })
    expect(out.result).toBe('ENV_AUTH_FAILURE')
    expect(out.detail).toMatch(/cf-mitigated/i)
  })

  it('reached + no block + no composer → UNCLASSIFIED, never environment', () => {
    // status 200, no cf-mitigated, no marker, no nav error — genuinely unexplained.
    const out = classifyNoComposer({
      navError: false,
      status: 200,
      cfMitigated: false,
      envMarker: null,
    })
    expect(out.result).toBe('UNCLASSIFIED')
    expect(out.detail).toMatch(/must be diagnosed/i)
    expect(out.result).not.toBe('ENV_AUTH_FAILURE')
  })

  it('a nav error dominates even if no marker was found', () => {
    expect(classifyNoComposer({ navError: true, envMarker: null }).result).toBe('ENV_AUTH_FAILURE')
  })

  it('a normal status (200) with no other signal is NOT environment', () => {
    expect(classifyNoComposer({ navError: false, status: 200, envMarker: null }).result).toBe(
      'UNCLASSIFIED',
    )
  })
})
