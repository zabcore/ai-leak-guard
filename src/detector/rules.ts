import type { Rule } from './types'
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
export const RULES: Rule[] = [
  {
    id: 'aws_access_key',
    label: 'AWS Access Key',
    severity: 'critical',
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
  },
  {
    id: 'github_pat',
    label: 'GitHub Token',
    severity: 'critical',
    pattern: /\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{36,}\b/g,
  },
  {
    id: 'anthropic_key',
    label: 'Anthropic API Key',
    severity: 'critical',
    pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    id: 'openai_key',
    label: 'OpenAI API Key',
    severity: 'critical',
    pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    id: 'stripe_key',
    label: 'Stripe Key',
    severity: 'critical',
    pattern: /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{20,}\b/g,
  },
  {
    id: 'google_api_key',
    label: 'Google API Key',
    severity: 'critical',
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
  },
  {
    id: 'jwt',
    label: 'JWT',
    severity: 'high',
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  },
  {
    id: 'private_key_block',
    label: 'Private Key',
    severity: 'critical',
    pattern:
      /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g,
  },
  {
    id: 'ssn',
    label: 'US Social Security Number',
    severity: 'high',
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
    validate: isValidSsn,
  },
  {
    id: 'credit_card',
    label: 'Credit Card',
    severity: 'high',
    pattern: /\b(?:\d[ -]?){13,19}\b/g,
    validate: luhn,
  },
  {
    id: 'generic_secret',
    label: 'Possible Secret',
    severity: 'medium',
    pattern:
      /\b(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|auth(?:_token)?|bearer)\s*[:=]\s*["']?([A-Za-z0-9+/=_-]{16,})["']?/gi,
    validate: isHighEntropySecret,
  },
]
