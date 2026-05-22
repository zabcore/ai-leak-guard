import { describe, it, expect } from 'vitest'
import { luhn, shannonEntropy, isValidSsn } from '../src/detector/validators'

describe('luhn', () => {
  it('passes for a valid Visa number', () => {
    expect(luhn('4532015112830366')).toBe(true)
  })

  it('passes for a valid Mastercard number', () => {
    expect(luhn('5425233430109903')).toBe(true)
  })

  it('fails for a number with a bad check digit', () => {
    expect(luhn('4532015112830367')).toBe(false)
  })

  it('ignores spaces', () => {
    expect(luhn('4532 0151 1283 0366')).toBe(true)
  })

  it('ignores hyphens', () => {
    expect(luhn('4532-0151-1283-0366')).toBe(true)
  })

  it('rejects non-digit input', () => {
    expect(luhn('4532abcd11283036')).toBe(false)
  })

  it('rejects input shorter than 13 digits', () => {
    expect(luhn('411111111111')).toBe(false)
  })

  it('rejects input longer than 19 digits', () => {
    expect(luhn('45320151128303661234')).toBe(false)
  })

  it('rejects an empty string', () => {
    expect(luhn('')).toBe(false)
  })
})

describe('shannonEntropy', () => {
  it('is above 3.5 for a strong password', () => {
    expect(shannonEntropy('MyS3cretP@ssw0rd2024')).toBeGreaterThan(3.5)
  })

  it('is above 3.5 for a random token', () => {
    expect(shannonEntropy('aB3xK9mP2qR7sT1vW5yZ8nC4')).toBeGreaterThan(3.5)
  })

  it('is below 1.0 for a repeated character', () => {
    expect(shannonEntropy('aaaaaaaaaaaaaaaa')).toBeLessThan(1.0)
  })

  it('is exactly 0 for a single repeated character', () => {
    expect(shannonEntropy('aaaaaaaa')).toBe(0)
  })

  it('returns 0 for an empty string', () => {
    expect(shannonEntropy('')).toBe(0)
  })

  it('is 1.0 for an evenly split two-symbol string', () => {
    expect(shannonEntropy('abab')).toBeCloseTo(1.0, 10)
  })
})

describe('isValidSsn', () => {
  it('accepts a valid SSN', () => {
    expect(isValidSsn('123-45-6789')).toBe(true)
  })

  it('rejects area number 000', () => {
    expect(isValidSsn('000-12-3456')).toBe(false)
  })

  it('rejects area number 666', () => {
    expect(isValidSsn('666-12-3456')).toBe(false)
  })

  it('rejects area number 900 (9XX range)', () => {
    expect(isValidSsn('900-12-3456')).toBe(false)
  })

  it('rejects area number 999 (9XX range)', () => {
    expect(isValidSsn('999-12-3456')).toBe(false)
  })

  it('rejects group number 00', () => {
    expect(isValidSsn('123-00-4567')).toBe(false)
  })

  it('rejects serial number 0000', () => {
    expect(isValidSsn('123-45-0000')).toBe(false)
  })

  it('rejects input without hyphens', () => {
    expect(isValidSsn('123456789')).toBe(false)
  })

  it('rejects malformed segment lengths', () => {
    expect(isValidSsn('12-345-6789')).toBe(false)
  })

  it('rejects input with surrounding text', () => {
    expect(isValidSsn('SSN 123-45-6789')).toBe(false)
  })
})
