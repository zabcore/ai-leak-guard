export type Severity = 'critical' | 'high' | 'medium' | 'low'

// V1.1 taxonomy. Modeled as const objects (plus a companion type) so members
// are plain string literals — assignable to Severity where they overlap and
// friendly to snapshot serialization.
export const DetectorCategory = {
  IDENTITY: 'identity',
  HEALTHCARE_PATIENT_ID: 'healthcare_patient_id',
  GOVERNMENT_FINANCIAL: 'government_financial',
  PROVIDER_ID: 'provider_id',
  CLINICAL_CONTEXT: 'clinical_context',
  DEVELOPER_CREDENTIAL: 'developer_credential',
} as const
export type DetectorCategory = (typeof DetectorCategory)[keyof typeof DetectorCategory]

export const SensitivityLevel = {
  CRITICAL: 'critical',
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low',
} as const
export type SensitivityLevel = (typeof SensitivityLevel)[keyof typeof SensitivityLevel]

export interface Rule {
  id: string
  label: string
  pattern: RegExp
  validate?: (match: string) => boolean
  severity: Severity
}

// V1.1: rules that participate in the taxonomy + combination-scoring pipeline.
// The RULES table is typed as DetectorRule[]. `Rule` is kept unchanged so
// callers/tests constructing bare rules (without taxonomy fields) still work.
export interface DetectorRule extends Rule {
  category: DetectorCategory
  baseSensitivity: SensitivityLevel
  /**
   * True for CLINICAL_CONTEXT rules that contribute to scoring but are never
   * masked on their own (their `effectiveSensitivity` is LOW).
   */
  isContextSignal?: boolean
  /**
   * Explicit placeholder inserted by the masker (e.g. `"[MRN]"`). When absent,
   * the masker derives one from `label` (e.g. `"Date of Birth"` →
   * `"[DATE_OF_BIRTH]"`). Existing V1 rules leave this undefined and rely on
   * the label-derived form; V1.1 healthcare rules set an explicit short token.
   */
  maskToken?: string
}

export interface Finding {
  ruleId: string
  label: string
  severity: Severity
  start: number
  end: number
  value: string
  // V1.1 taxonomy fields — populated by detect() when the source rule is a
  // DetectorRule. Optional so callers/tests that construct Finding objects
  // manually (without taxonomy) remain valid.
  category?: DetectorCategory
  baseSensitivity?: SensitivityLevel
  effectiveSensitivity?: SensitivityLevel
  isContextSignal?: boolean
  /** Optional explicit mask token inherited from the source rule. */
  maskToken?: string
}

// V1.1 result envelope for callers that want the aggregate flag alongside the
// findings. Legacy consumers can continue to call detect() which returns the
// findings array directly.
export interface DetectionResult {
  findings: Finding[]
  hasCriticalOrHigh: boolean
}
