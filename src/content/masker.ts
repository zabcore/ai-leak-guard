import type { Finding } from '../detector/types'

export interface MaskedSegment {
  original: string
  placeholder: string
  ruleId: string
  label: string
}

export interface MaskResult {
  text: string
  maskedSegments: MaskedSegment[]
}

// "AWS Access Key" -> "[AWS_ACCESS_KEY]"
function toPlaceholder(label: string): string {
  return `[${label.toUpperCase().replace(/\s+/g, '_')}]`
}

// Pure function: no DOM, no Chrome APIs. Replaces each finding's range with a
// `[LABEL]` placeholder and reports the masked segments.
export function mask(text: string, findings: Finding[]): MaskResult {
  if (findings.length === 0) {
    return { text, maskedSegments: [] }
  }

  const sorted = [...findings].sort((a, b) => a.start - b.start)
  const maskedSegments: MaskedSegment[] = []
  let result = ''
  let cursor = 0

  for (const finding of sorted) {
    // Skip findings that overlap a range we have already masked.
    if (finding.start < cursor) continue

    const placeholder = toPlaceholder(finding.label)
    result += text.slice(cursor, finding.start) + placeholder
    maskedSegments.push({
      original: text.slice(finding.start, finding.end),
      placeholder,
      ruleId: finding.ruleId,
      label: finding.label,
    })
    cursor = finding.end
  }

  result += text.slice(cursor)
  return { text: result, maskedSegments }
}
