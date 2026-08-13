import type { DetectorRule } from './types'
import { DetectorCategory, SensitivityLevel } from './types'
import { isValidSsn, luhn, shannonEntropy } from './validators'

const GENERIC_SECRET_MIN_ENTROPY = 3.5

// Re-extracts the secret value (capture group) from a full generic-secret match.
// Has no global flag, so it is safe to reuse without lastIndex bookkeeping.
const GENERIC_SECRET_VALUE = /[:=]\s*["']?([A-Za-z0-9+/=_-]{16,})/

function isHighEntropySecret(match: string): boolean {
  const valueMatch = GENERIC_SECRET_VALUE.exec(match)
  if (valueMatch === null) return false
  return shannonEntropy(valueMatch[1]) > GENERIC_SECRET_MIN_ENTROPY
}

// `anthropic_key` is intentionally ordered before `openai_key`: an Anthropic key
// (`sk-ant-...`) also satisfies the broader OpenAI pattern, so listing the more
// specific rule first lets mergeOverlapping keep the correct label on a tie.
//
// V1.1: each rule now carries a `category` and a `baseSensitivity`. The
// existing `severity` field is preserved unchanged (overlap-merge ranking and
// backward compatibility still key off it); `baseSensitivity` is the value the
// V1.1 preview UX and combination scoring reason about. For the current V1 rule
// set both values happen to agree in the aggregate — everything currently
// masked has base CRITICAL or HIGH — so no observable behavior changes.
export const RULES: DetectorRule[] = [
  {
    id: 'aws_access_key',
    label: 'AWS Access Key',
    severity: 'critical',
    category: DetectorCategory.DEVELOPER_CREDENTIAL,
    baseSensitivity: SensitivityLevel.CRITICAL,
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
  },
  {
    id: 'github_pat',
    label: 'GitHub Token',
    severity: 'critical',
    category: DetectorCategory.DEVELOPER_CREDENTIAL,
    baseSensitivity: SensitivityLevel.CRITICAL,
    pattern: /\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{36,}\b/g,
  },
  {
    id: 'anthropic_key',
    label: 'Anthropic API Key',
    severity: 'critical',
    category: DetectorCategory.DEVELOPER_CREDENTIAL,
    baseSensitivity: SensitivityLevel.CRITICAL,
    pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    id: 'openai_key',
    label: 'OpenAI API Key',
    severity: 'critical',
    category: DetectorCategory.DEVELOPER_CREDENTIAL,
    baseSensitivity: SensitivityLevel.CRITICAL,
    pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    id: 'stripe_key',
    label: 'Stripe Key',
    severity: 'critical',
    category: DetectorCategory.DEVELOPER_CREDENTIAL,
    baseSensitivity: SensitivityLevel.CRITICAL,
    pattern: /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{20,}\b/g,
  },
  {
    id: 'google_api_key',
    label: 'Google API Key',
    severity: 'critical',
    category: DetectorCategory.DEVELOPER_CREDENTIAL,
    baseSensitivity: SensitivityLevel.CRITICAL,
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
  },
  {
    id: 'jwt',
    label: 'JWT',
    severity: 'high',
    category: DetectorCategory.DEVELOPER_CREDENTIAL,
    baseSensitivity: SensitivityLevel.HIGH,
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  },
  {
    id: 'private_key_block',
    label: 'Private Key',
    severity: 'critical',
    category: DetectorCategory.DEVELOPER_CREDENTIAL,
    baseSensitivity: SensitivityLevel.CRITICAL,
    pattern:
      /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g,
  },
  {
    id: 'ssn',
    label: 'US Social Security Number',
    severity: 'high',
    category: DetectorCategory.GOVERNMENT_FINANCIAL,
    baseSensitivity: SensitivityLevel.CRITICAL,
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
    validate: isValidSsn,
  },
  {
    id: 'credit_card',
    label: 'Credit Card',
    severity: 'high',
    category: DetectorCategory.GOVERNMENT_FINANCIAL,
    baseSensitivity: SensitivityLevel.CRITICAL,
    pattern: /\b(?:\d[ -]?){13,19}\b/g,
    validate: luhn,
  },
  {
    id: 'generic_secret',
    label: 'Possible Secret',
    severity: 'medium',
    category: DetectorCategory.DEVELOPER_CREDENTIAL,
    baseSensitivity: SensitivityLevel.HIGH,
    pattern:
      /\b(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|auth(?:_token)?|bearer)\s*[:=]\s*["']?([A-Za-z0-9+/=_-]{16,})["']?/gi,
    validate: isHighEntropySecret,
  },
]
