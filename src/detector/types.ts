export type Severity = 'critical' | 'high' | 'medium'

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
  match: string
  start: number
  end: number
  severity: Severity
}
