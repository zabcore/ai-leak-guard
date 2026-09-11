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

/** True if (year, month, day) is a real calendar date with a plausible birth year. */
function isRealBirthDate(year: number, month: number, day: number): boolean {
  const currentYear = new Date().getUTCFullYear()
  if (year < 1900 || year > currentYear) return false
  if (month < 1 || month > 12) return false
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return day >= 1 && day <= daysInMonth[month - 1]
}

// Expand a 2-digit year: this century if not in the future, else last
// century (so "05" reads as 2005, "62" as 1962).
function expandYear(raw: string): number {
  const y = Number(raw)
  if (raw.length !== 2) return y
  const nowYY = new Date().getUTCFullYear() % 100
  return y <= nowYY ? 2000 + y : 1900 + y
}

/**
 * V1.3.1 — validate the DATE VALUE of a date-of-birth match as a real
 * calendar date and a plausible birth year. Accepts ISO `Y-M-D`
 * (unambiguous) and a two-field slashed/dotted/dashed form `A/B/Y`.
 *
 * DAY-FIRST SUPPORT (V1.3.1 fix): the slashed form is accepted if EITHER
 * `A=month,B=day` (US `MM/DD/YYYY`) OR `A=day,B=month` (`DD/MM/YYYY`) is a
 * real calendar date. So `23/12/2017` (day-first) and `12/23/2017`
 * (month-first) both pass, and an ambiguous `03/04/2017` passes without
 * us choosing or converting its meaning — we only detect and protect the
 * ORIGINAL text. A date invalid under BOTH readings (`31/04/2017`,
 * `13/40/1980`, `02/30/1980`) is rejected. Label anchoring is unchanged
 * (an unlabelled date never reaches this validator).
 */
const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
}

export function isValidDobDate(value: string): boolean {
  const iso = /^(\d{4})[-.](\d{1,2})[-.](\d{1,2})$/.exec(value)
  if (iso !== null) {
    return isRealBirthDate(Number(iso[1]), Number(iso[2]), Number(iso[3]))
  }
  // Written-month form (either order). The month is a NAME, so the two
  // numeric fields are unambiguous: read left-to-right the first is the
  // day and the second is the year, in BOTH "Sep 20 1988" (month-first)
  // and "20 Sep 1988" (day-first).
  const mn = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i.exec(value)
  if (mn !== null) {
    const month = MONTHS[mn[1].toLowerCase()]
    const nums = value.match(/\d{1,4}/g)
    if (nums === null || nums.length < 2) return false
    return isRealBirthDate(expandYear(nums[1]), month, Number(nums[0]))
  }
  const two = /^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/.exec(value)
  if (two === null) return false
  const a = Number(two[1])
  const b = Number(two[2])
  const year = expandYear(two[3])
  // Accept if either month/day assignment yields a real date. Ambiguous
  // values are detected (and protected) without disambiguating.
  return isRealBirthDate(year, a, b) || isRealBirthDate(year, b, a)
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
