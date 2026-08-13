// Pure validation helpers used by detection rules. No DOM, Chrome, or network access.

export function luhn(num: string): boolean {
  const digits = num.replace(/[\s-]/g, '')
  if (!/^\d+$/.test(digits)) return false
  if (digits.length < 13 || digits.length > 19) return false

  let sum = 0
  let double = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48
    if (double) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
    double = !double
  }
  return sum % 10 === 0
}

export function shannonEntropy(s: string): number {
  if (s.length === 0) return 0

  const freq = new Map<string, number>()
  for (const ch of s) {
    freq.set(ch, (freq.get(ch) ?? 0) + 1)
  }

  let entropy = 0
  for (const count of freq.values()) {
    const p = count / s.length
    entropy -= p * Math.log2(p)
  }
  return entropy
}

export function isValidSsn(s: string): boolean {
  const match = /^(\d{3})-(\d{2})-(\d{4})$/.exec(s)
  if (match === null) return false

  const [, area, group, serial] = match
  if (area === '000' || area === '666') return false
  if (Number(area) >= 900) return false
  if (group === '00') return false
  if (serial === '0000') return false
  return true
}

// ─── V1.1 healthcare validators ───────────────────────────────────────────────

/**
 * NPI check-digit validation. NPIs are 10 digits; the CMS-defined algorithm
 * prepends the industry prefix "80840" and runs Luhn over the 15-digit result.
 * The last of the 10 digits IS the check digit.
 */
export function isValidNpi(value: string): boolean {
  if (!/^\d{10}$/.test(value)) return false
  const digits = `80840${value}`
  let sum = 0
  let double = false
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48
    if (double) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
    double = !double
  }
  return sum % 10 === 0
}

// Valid DEA registrant-type letters (first character). Intentionally conservative:
// covers the types the DEA has actually issued (with historical gaps like `I`).
// The second letter is the registrant's last-name initial — we do NOT validate it
// beyond `[A-Z]` (per the spec: "don't over-validate the letters").
const DEA_REGISTRANT_TYPES = new Set([
  'A',
  'B',
  'C',
  'D',
  'E',
  'F',
  'G',
  'H',
  'J',
  'K',
  'L',
  'M',
  'N',
  'P',
  'Q',
  'R',
  'S',
  'T',
  'U',
  'X',
])

/**
 * DEA number check-digit validation. Format: two letters followed by seven
 * digits. Checksum = (d1 + d3 + d5) + 2 * (d2 + d4 + d6); the ones digit of the
 * checksum must equal d7. First letter must be an issued registrant type.
 */
export function isValidDea(value: string): boolean {
  const match = /^([A-Z])([A-Z])(\d{7})$/.exec(value)
  if (match === null) return false
  if (!DEA_REGISTRANT_TYPES.has(match[1])) return false

  const [d1, d2, d3, d4, d5, d6, d7] = match[3].split('').map(Number)
  const checksum = d1 + d3 + d5 + 2 * (d2 + d4 + d6)
  return checksum % 10 === d7
}

/**
 * Cheap plausibility filter for a phone-shaped match. Scope matches the
 * detector's regex (North American: 10 digits, or 11 with a leading `+1`
 * country code) — kept aligned so a validator-accepted value can never
 * fall outside what the regex is willing to match. Also rejects single
 * repeated digit runs like "1111111111".
 */
export function isPlausiblePhone(value: string): boolean {
  const digits = value.replace(/\D/g, '')
  if (digits.length !== 10 && !(digits.length === 11 && digits[0] === '1')) return false
  if (/^(\d)\1+$/.test(digits)) return false
  return true
}
