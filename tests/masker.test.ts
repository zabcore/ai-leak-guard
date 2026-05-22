import { describe, it, expect } from 'vitest'
import { mask } from '../src/content/masker'
import type { Finding, Severity } from '../src/detector/types'

function finding(
  start: number,
  end: number,
  label: string,
  ruleId = 'rule',
  severity: Severity = 'high',
): Finding {
  return { ruleId, label, severity, start, end, value: '' }
}

describe('mask', () => {
  it('returns the text unchanged when there are no findings', () => {
    const result = mask('nothing to see here', [])
    expect(result.text).toBe('nothing to see here')
    expect(result.maskedSegments).toEqual([])
  })

  it('masks a single finding', () => {
    const text = 'key AKIAIOSFODNN7EXAMPLE here'
    const start = text.indexOf('AKIA')
    const result = mask(text, [finding(start, start + 20, 'AWS Access Key', 'aws_access_key')])
    expect(result.text).toBe('key [AWS_ACCESS_KEY] here')
    expect(result.maskedSegments).toHaveLength(1)
  })

  it('masks multiple findings and sorts them by position', () => {
    const text = 'key AKIAIOSFODNN7EXAMPLE and ssn 123-45-6789 end'
    const awsStart = text.indexOf('AKIA')
    const ssnStart = text.indexOf('123-45-6789')
    const aws = finding(awsStart, awsStart + 20, 'AWS Access Key', 'aws_access_key')
    const ssn = finding(ssnStart, ssnStart + 11, 'US Social Security Number', 'ssn')
    // Pass out of order to confirm sorting.
    const result = mask(text, [ssn, aws])
    expect(result.text).toBe('key [AWS_ACCESS_KEY] and ssn [US_SOCIAL_SECURITY_NUMBER] end')
    expect(result.maskedSegments).toHaveLength(2)
  })

  it('masks a finding at the start of the string', () => {
    const text = 'AKIAIOSFODNN7EXAMPLE trailing'
    const result = mask(text, [finding(0, 20, 'AWS Access Key', 'aws_access_key')])
    expect(result.text).toBe('[AWS_ACCESS_KEY] trailing')
  })

  it('masks a finding at the end of the string', () => {
    const text = 'leading 123-45-6789'
    const start = text.indexOf('123-45-6789')
    const result = mask(text, [finding(start, start + 11, 'US Social Security Number', 'ssn')])
    expect(result.text).toBe('leading [US_SOCIAL_SECURITY_NUMBER]')
  })

  it('handles overlapping findings gracefully by skipping the overlap', () => {
    const text = 'abcdefghij'
    const result = mask(text, [finding(2, 6, 'First', 'first'), finding(4, 8, 'Second', 'second')])
    expect(result.text).toBe('ab[FIRST]ghij')
    expect(result.maskedSegments).toHaveLength(1)
    expect(result.maskedSegments[0].ruleId).toBe('first')
  })

  it('captures original text and metadata for each segment', () => {
    const text = 'key AKIAIOSFODNN7EXAMPLE here'
    const start = text.indexOf('AKIA')
    const result = mask(text, [finding(start, start + 20, 'AWS Access Key', 'aws_access_key')])
    expect(result.maskedSegments[0]).toEqual({
      original: 'AKIAIOSFODNN7EXAMPLE',
      placeholder: '[AWS_ACCESS_KEY]',
      ruleId: 'aws_access_key',
      label: 'AWS Access Key',
    })
  })

  it('converts labels to uppercase underscore placeholders', () => {
    const text = 'token = secret-value-1234567890'
    const result = mask(text, [finding(0, text.length, 'Possible Secret', 'generic_secret')])
    expect(result.text).toBe('[POSSIBLE_SECRET]')
  })

  it('preserves text between two findings', () => {
    const text = 'XX---YY'
    const result = mask(text, [finding(0, 2, 'A', 'a'), finding(5, 7, 'B', 'b')])
    expect(result.text).toBe('[A]---[B]')
  })

  it('does not mutate the input findings array order', () => {
    const a = finding(5, 7, 'B', 'b')
    const b = finding(0, 2, 'A', 'a')
    const input = [a, b]
    mask('XX---YY', input)
    expect(input[0]).toBe(a)
    expect(input[1]).toBe(b)
  })
})
