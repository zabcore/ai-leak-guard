import type { DetectionResult, DetectorRule, Finding, Rule, Severity } from './types'
import { DetectorCategory, SensitivityLevel } from './types'
import { RULES } from './rules'

const MIN_TEXT_LENGTH = 8
const LARGE_INPUT_THRESHOLD = 100_000

const SEVERITY_RANK: Record<Severity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
}

function isDetectorRule(rule: Rule): rule is DetectorRule {
  const candidate = rule as Partial<DetectorRule>
  return candidate.category !== undefined && candidate.baseSensitivity !== undefined
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
      const finding: Finding = {
        ruleId: rule.id,
        label: rule.label,
        severity: rule.severity,
        start: match.index,
        end: match.index + value.length,
        value,
      }
      // V1.1: carry the source rule's taxonomy onto the finding so downstream
      // scoring and preview code can reason about it. Bare Rule inputs (no
      // taxonomy) yield findings without these fields — legacy consumers see
      // no change.
      if (isDetectorRule(rule)) {
        finding.category = rule.category
        finding.baseSensitivity = rule.baseSensitivity
        finding.isContextSignal = rule.isContextSignal
      }
      findings.push(finding)
    }
  }

  return applyCombinationScoring(mergeOverlapping(findings))
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

// V1.1 combination scoring — compute `effectiveSensitivity` for each finding.
//
// Rule A: any finding whose `category` is NOT CLINICAL_CONTEXT keeps its
//         `baseSensitivity` as its `effectiveSensitivity`.
// Rule B: any finding whose `category` IS CLINICAL_CONTEXT is LOW in V1.1
//         regardless of what else is present in the text — alone, alongside an
//         IDENTITY / HEALTHCARE_PATIENT_ID finding, or alongside only
//         GOVERNMENT_FINANCIAL / PROVIDER_ID findings. (The identifiers get
//         masked; the context stays visible.)
// Rule C: LOW is never promoted to a higher level in V1.1. Future V1.2 may
//         escalate identifier sensitivity when clinical context is present, but
//         it will not raise the context finding itself.
//
// No CLINICAL_CONTEXT rules exist in this PR — the scoring layer is being
// installed ahead of PR 2 which adds them, so the runtime is a no-op today.
// Findings without `baseSensitivity` (bare-Rule inputs) pass through unchanged.
export function applyCombinationScoring(findings: Finding[]): Finding[] {
  return findings.map((finding) => {
    if (finding.baseSensitivity === undefined) return finding
    if (finding.category !== DetectorCategory.CLINICAL_CONTEXT) {
      // Rule A: non-context finding keeps its base sensitivity.
      return { ...finding, effectiveSensitivity: finding.baseSensitivity }
    }
    // Rules B + C: CLINICAL_CONTEXT is always LOW in V1.1.
    return { ...finding, effectiveSensitivity: SensitivityLevel.LOW }
  })
}

/**
 * True when at least one finding's `effectiveSensitivity` is CRITICAL or HIGH.
 * Used by the content script to decide whether to intercept a paste, and by
 * callers of `detectDetailed` to check the convenience flag.
 */
export function hasCriticalOrHigh(findings: Finding[]): boolean {
  return findings.some(
    (finding) =>
      finding.effectiveSensitivity === SensitivityLevel.CRITICAL ||
      finding.effectiveSensitivity === SensitivityLevel.HIGH,
  )
}

/**
 * True when a finding should be masked by the content script. Findings whose
 * `effectiveSensitivity` was never set (bare-Rule input, no taxonomy) mask by
 * default to preserve pre-V1.1 behavior.
 */
export function isMaskable(finding: Finding): boolean {
  if (finding.effectiveSensitivity === undefined) return true
  return (
    finding.effectiveSensitivity === SensitivityLevel.CRITICAL ||
    finding.effectiveSensitivity === SensitivityLevel.HIGH
  )
}

/**
 * V1.1 convenience wrapper that returns the findings alongside the aggregate
 * `hasCriticalOrHigh` flag. Prefer this in new call sites; `detect()` remains
 * for backward compatibility.
 */
export function detectDetailed(text: string, rules: Rule[] = RULES): DetectionResult {
  const findings = detect(text, rules)
  return { findings, hasCriticalOrHigh: hasCriticalOrHigh(findings) }
}
