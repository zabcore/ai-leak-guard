import type { Finding, Rule, Severity } from './types'
import { RULES } from './rules'

const MIN_TEXT_LENGTH = 8
const LARGE_INPUT_THRESHOLD = 100_000

const SEVERITY_RANK: Record<Severity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
}

// Pure detection: same input always yields the same output. No DOM, Chrome,
// network, or other side effects beyond an optional console warning.
export function detect(text: string, rules: Rule[] = RULES): Finding[] {
  if (text.length < MIN_TEXT_LENGTH) return []
  if (text.length > LARGE_INPUT_THRESHOLD) {
    console.warn(`[AI Leak Guard] detect() called on large input (${text.length} chars)`)
  }

  const findings: Finding[] = []
  for (const rule of rules) {
    // A non-global pattern never advances lastIndex, so exec() in the loop
    // below would spin forever. Fail loudly instead — this also guards against
    // malformed remote rules in a future rules-updater.
    if (!rule.pattern.global) {
      throw new Error(`[AI Leak Guard] rule "${rule.id}" pattern must use the global (g) flag`)
    }
    rule.pattern.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = rule.pattern.exec(text)) !== null) {
      const value = match[0]
      if (value.length === 0) {
        rule.pattern.lastIndex += 1
        continue
      }
      if (rule.validate !== undefined && !rule.validate(value)) {
        continue
      }
      findings.push({
        ruleId: rule.id,
        label: rule.label,
        severity: rule.severity,
        start: match.index,
        end: match.index + value.length,
        value,
      })
    }
  }

  return mergeOverlapping(findings)
}

// Resolve overlapping findings: higher severity wins; on a severity tie the
// longer match wins; otherwise the earlier finding is kept.
export function mergeOverlapping(findings: Finding[]): Finding[] {
  if (findings.length <= 1) return findings.slice()

  const sorted = [...findings].sort((a, b) => a.start - b.start)
  const result: Finding[] = [sorted[0]]

  for (let i = 1; i < sorted.length; i += 1) {
    const current = sorted[i]
    const previous = result[result.length - 1]

    if (current.start < previous.end) {
      const currentRank = SEVERITY_RANK[current.severity]
      const previousRank = SEVERITY_RANK[previous.severity]
      const currentLength = current.end - current.start
      const previousLength = previous.end - previous.start

      const replacePrevious =
        currentRank > previousRank ||
        (currentRank === previousRank && currentLength > previousLength)

      if (replacePrevious) {
        result[result.length - 1] = current
      }
    } else {
      result.push(current)
    }
  }

  return result
}
