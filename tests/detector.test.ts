import { describe, it, expect } from 'vitest'
import { detect, mergeOverlapping } from '../src/detector/engine'
import { RULES } from '../src/detector/rules'
import type { Finding } from '../src/detector/types'

function ruleIds(findings: Finding[]): string[] {
  return findings.map((f) => f.ruleId)
}

describe('detect — positive cases (one per rule)', () => {
  it('detects an AWS access key', () => {
    expect(ruleIds(detect('Here is AKIAIOSFODNN7EXAMPLE in the config'))).toContain(
      'aws_access_key',
    )
  })

  it('detects a GitHub token', () => {
    expect(ruleIds(detect('use token ghp_abcdefghijklmnopqrstuvwxyz0123456789 now'))).toContain(
      'github_pat',
    )
  })

  it('detects an OpenAI API key', () => {
    expect(
      ruleIds(detect('export key sk-proj-abc123def456ghi789jkl012mno345pqr678 here')),
    ).toContain('openai_key')
  })

  it('detects an Anthropic API key (winning the overlap with the OpenAI rule)', () => {
    const findings = detect('key sk-ant-api03-abc123def456ghi789jkl012mno345 here')
    expect(ruleIds(findings)).toContain('anthropic_key')
    expect(ruleIds(findings)).not.toContain('openai_key')
  })

  it('detects a Stripe key', () => {
    expect(ruleIds(detect('charge with sk_live_abcdefghijklmnopqrstuvwx today'))).toContain(
      'stripe_key',
    )
  })

  it('detects a Google API key', () => {
    expect(ruleIds(detect('maps key AIzaSyDxVlAabc123def456ghi789jkl012mno3 here'))).toContain(
      'google_api_key',
    )
  })

  it('detects a JWT', () => {
    expect(
      ruleIds(
        detect('auth eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123def456ghi789 here'),
      ),
    ).toContain('jwt')
  })

  it('detects a private key block', () => {
    const block = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEowIBAAKCAQEABCDEFGHIJKLMNOPqrstuvwx',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n')
    const findings = detect(block)
    expect(ruleIds(findings)).toContain('private_key_block')
    expect(findings[0].value).toContain('BEGIN RSA PRIVATE KEY')
  })

  it('detects a valid SSN', () => {
    expect(ruleIds(detect('John Smith SSN 123-45-6789'))).toContain('ssn')
  })

  it('detects a Luhn-valid credit card', () => {
    expect(ruleIds(detect('Card: 4532015112830366'))).toContain('credit_card')
  })

  it('detects a high-entropy generic secret', () => {
    expect(ruleIds(detect('api_key = "aB3xK9mP2qR7sT1vW5yZ8nC4"'))).toContain('generic_secret')
  })
})

describe('detect — negative cases (near-misses, one per rule)', () => {
  it('does not match a bare AKIA prefix', () => {
    expect(detect('AKIA is a common AWS prefix')).toHaveLength(0)
  })

  it('does not match a too-short GitHub token', () => {
    expect(detect('the token ghp_shorthere is invalid')).toHaveLength(0)
  })

  it('does not match a too-short OpenAI key', () => {
    expect(detect('the key sk-short is invalid')).toHaveLength(0)
  })

  it('does not match a too-short Anthropic key', () => {
    expect(detect('the key sk-ant-tiny is invalid')).toHaveLength(0)
  })

  it('does not match a too-short Stripe key', () => {
    expect(detect('the key sk_live_short is invalid')).toHaveLength(0)
  })

  it('does not match a too-short Google key', () => {
    expect(detect('the key AIzaShort is invalid')).toHaveLength(0)
  })

  it('does not match a two-segment pseudo-JWT', () => {
    expect(detect('the token eyJabc.def is invalid')).toHaveLength(0)
  })

  it('does not match a non-private key block', () => {
    expect(detect('a BEGIN PUBLIC KEY block is harmless')).toHaveLength(0)
  })

  it('does not match a phone number formatted like an SSN', () => {
    expect(detect('My phone number is 123-456-7890')).toHaveLength(0)
  })

  it('does not match a Luhn-invalid credit card', () => {
    expect(detect('Order #5425233430109904 shipped today')).toHaveLength(0)
  })

  it('does not match a low-entropy generic secret', () => {
    expect(detect('token = "aaaaaaaaaaaaaaaaaaaa"')).toHaveLength(0)
  })
})

describe('detect — known false positives stay clean', () => {
  it('ignores the word "password" without an assignment', () => {
    expect(detect('Use the password field below')).toHaveLength(0)
  })

  it('ignores the phrase "API key" without a value', () => {
    expect(detect('See the API key documentation here')).toHaveLength(0)
  })

  it('ignores ordinary prose', () => {
    expect(detect('What is the capital of France?')).toHaveLength(0)
  })
})

describe('detect — SSN exclusion boundaries', () => {
  it('does not flag an SSN with area 000', () => {
    expect(detect('Their SSN is 000-12-3456 on file')).toHaveLength(0)
  })

  it('does not flag an SSN with area 666', () => {
    expect(detect('Their SSN is 666-45-6789 on file')).toHaveLength(0)
  })

  it('does not flag an SSN with area in the 9XX range', () => {
    expect(detect('Their SSN is 900-12-3456 on file')).toHaveLength(0)
  })
})

describe('detect — engine behavior', () => {
  it('returns [] for an empty string', () => {
    expect(detect('')).toEqual([])
  })

  it('returns [] for whitespace only', () => {
    expect(detect('            ')).toEqual([])
  })

  it('returns [] for text shorter than 8 characters', () => {
    expect(detect('short')).toEqual([])
  })

  it('returns [] for plain text with no sensitive data', () => {
    expect(detect('The quick brown fox jumps over the lazy dog.')).toEqual([])
  })

  it('uses the default RULES when no rules argument is given', () => {
    expect(ruleIds(detect('contains AKIAIOSFODNN7EXAMPLE here'))).toContain('aws_access_key')
  })

  it('reports correct ruleId, value, start, and end for a single finding', () => {
    const text = 'prefix AKIAIOSFODNN7EXAMPLE suffix'
    const findings = detect(text)
    expect(findings).toHaveLength(1)
    const [finding] = findings
    expect(finding.ruleId).toBe('aws_access_key')
    expect(finding.value).toBe('AKIAIOSFODNN7EXAMPLE')
    expect(finding.start).toBe(text.indexOf('AKIAIOSFODNN7EXAMPLE'))
    expect(finding.end).toBe(finding.start + finding.value.length)
    expect(text.slice(finding.start, finding.end)).toBe(finding.value)
  })

  it('finds three distinct items in a mixed payload with correct positions', () => {
    const text = 'SSN 123-45-6789 AWS AKIAIOSFODNN7EXAMPLE card 4532015112830366'
    const findings = detect(text)
    expect(findings).toHaveLength(3)
    expect(ruleIds(findings).sort()).toEqual(['aws_access_key', 'credit_card', 'ssn'])
    for (const finding of findings) {
      expect(text.slice(finding.start, finding.end)).toBe(finding.value)
    }
  })

  it('keeps the higher-severity finding when matches overlap', () => {
    const findings = detect('api_key = sk-proj-abcdefghijklmnopqrst1234')
    expect(findings).toHaveLength(1)
    expect(findings[0].ruleId).toBe('openai_key')
    expect(findings[0].severity).toBe('critical')
  })

  it('is deterministic across repeated calls (no RegExp lastIndex leakage)', () => {
    const text = 'SSN 123-45-6789 AWS AKIAIOSFODNN7EXAMPLE card 4532015112830366'
    expect(detect(text)).toEqual(detect(text))
  })

  it('processes a 50KB input in under 100ms', () => {
    const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,-_'
    let buffer = ''
    for (let i = 0; i < 51200; i += 1) {
      buffer += charset[Math.floor(Math.random() * charset.length)]
    }
    const started = performance.now()
    const findings = detect(buffer)
    const elapsed = performance.now() - started
    expect(Array.isArray(findings)).toBe(true)
    expect(elapsed).toBeLessThan(100)
  })
})

describe('mergeOverlapping', () => {
  it('returns an empty array unchanged', () => {
    expect(mergeOverlapping([])).toEqual([])
  })

  it('keeps non-overlapping findings', () => {
    const findings: Finding[] = [
      { ruleId: 'a', label: 'A', severity: 'high', start: 0, end: 5, value: 'aaaaa' },
      { ruleId: 'b', label: 'B', severity: 'high', start: 10, end: 15, value: 'bbbbb' },
    ]
    expect(mergeOverlapping(findings)).toHaveLength(2)
  })

  it('keeps the longer match when overlapping findings share a severity', () => {
    const findings: Finding[] = [
      { ruleId: 'short', label: 'S', severity: 'high', start: 0, end: 4, value: 'shor' },
      { ruleId: 'long', label: 'L', severity: 'high', start: 0, end: 8, value: 'longlong' },
    ]
    const merged = mergeOverlapping(findings)
    expect(merged).toHaveLength(1)
    expect(merged[0].ruleId).toBe('long')
  })
})

describe('RULES integrity', () => {
  it('defines all eleven V1 rules', () => {
    expect(RULES).toHaveLength(11)
  })

  it('uses globally-flagged patterns for every rule', () => {
    for (const rule of RULES) {
      expect(rule.pattern.flags).toContain('g')
    }
  })
})
