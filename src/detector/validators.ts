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
