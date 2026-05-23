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

interface MergedRange {
  start: number
  end: number
  ruleId: string
  label: string
}

// Pure function: no DOM, no Chrome APIs. Replaces every byte covered by any
// finding with a `[LABEL]` placeholder. Overlapping findings are merged into a
// single covered range so no portion of a matched span can survive in the
// output; the earliest finding in a merged range supplies the label.
export function mask(text: string, findings: Finding[]): MaskResult {
  if (findings.length === 0) {
    return { text, maskedSegments: [] }
  }

  const sorted = [...findings].sort((a, b) => a.start - b.start)
  const merged: MergedRange[] = []
  for (const finding of sorted) {
    const last = merged[merged.length - 1]
    if (last !== undefined && finding.start < last.end) {
      // Overlaps the previous range — extend it so the overhang is also masked.
      last.end = Math.max(last.end, finding.end)
    } else {
      merged.push({
        start: finding.start,
        end: finding.end,
        ruleId: finding.ruleId,
        label: finding.label,
      })
    }
  }

  const maskedSegments: MaskedSegment[] = []
  let result = ''
  let cursor = 0
  for (const range of merged) {
    const placeholder = toPlaceholder(range.label)
    result += text.slice(cursor, range.start) + placeholder
    maskedSegments.push({
      original: text.slice(range.start, range.end),
      placeholder,
      ruleId: range.ruleId,
      label: range.label,
    })
    cursor = range.end
  }
  result += text.slice(cursor)

  return { text: result, maskedSegments }
}
