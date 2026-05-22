export type Severity = 'critical' | 'high' | 'medium' | 'low'

export interface Rule {
  id: string
  label: string
  pattern: RegExp
  validate?: (match: string) => boolean
  severity: Severity
}

export interface Finding {
  ruleId: string
  label: string
  severity: Severity
  start: number
  end: number
  value: string
}
