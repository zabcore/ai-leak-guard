import type { DetectorRule, Severity } from './types'
import { DetectorCategory, SensitivityLevel } from './types'
import { MEDICATIONS } from './data/medications'
import {
  isPlausiblePhone,
  isValidDea,
  isValidDobDate,
  isValidNpi,
  isValidSsn,
  luhn,
  shannonEntropy,
} from './validators'

const GENERIC_SECRET_MIN_ENTROPY = 3.5

// Re-extracts the secret value (capture group) from a full generic-secret match.
// Has no global flag, so it is safe to reuse without lastIndex bookkeeping.
const GENERIC_SECRET_VALUE = /[:=]\s*["']?([A-Za-z0-9+/=_-]{16,})/

function isHighEntropySecret(match: string): boolean {
  const valueMatch = GENERIC_SECRET_VALUE.exec(match)
  if (valueMatch === null) return false
  return shannonEntropy(valueMatch[1]) > GENERIC_SECRET_MIN_ENTROPY
}

// ─── V1.1 contextual-rule builder ─────────────────────────────────────────────
//
// Contextual detectors fire ONLY when a label + separator + value all appear
// together. They must NOT match a bare value (that would explode the false-
// positive rate on medical/financial identifiers). This helper factors the
// label/separator/value/word-boundary logic so every label-anchored detector
// shares one tested implementation.
//
// The generated pattern is `\b(?:LABEL)\s*[:#]?\s*(VALUE)\b` with the `gi`
// flag. The engine uses `match[0]` (the whole labeled span) as the finding's
// value — masking replaces the WHOLE labeled span with the mask token, so the
// output reads e.g. "This patient's [MRN]" rather than "This patient's MRN: [MRN]".
//
// If a `validateValue` callback is supplied, we re-extract the capture group
// from `match[0]` (the engine only hands the full match to `validate`) and
// pass it through the callback.
interface ContextualRuleConfig {
  id: string
  label: string
  category: DetectorCategory
  baseSensitivity: SensitivityLevel
  maskToken: string
  severity: Severity
  isContextSignal?: boolean
  labelPattern: string
  valuePattern: string
  // Overrides the default separator between the label and value. The default
  // `[:#]?` (optional colon or hash) matches PR 2's identifier detectors, where
  // labels like `MRN` / `Claim #` may appear with or without punctuation. Detectors
  // like `patient_name` and `street_address` need a REQUIRED punctuation separator
  // (`Patient:`, `Address -`, `Name =`) — otherwise a sentence fragment like
  // "the patient Sarah Khan" would over-fire on a bare-label prefix. Callers pass
  // the character class or pattern they want (unwrapped; the helper interpolates it
  // between `\\s*` on either side).
  separatorPattern?: string
  validateValue?: (value: string) => boolean
}

function contextualRule(cfg: ContextualRuleConfig): DetectorRule {
  const separator = cfg.separatorPattern ?? '[:#]?'
  // Wrap the separator in a non-capturing group so a caller-supplied alternation
  // (e.g. `:|=`) cannot escape and become a top-level alternative of the outer
  // pattern. Without the group, `label\s*:|=\s*(value)` reads as
  // `(label\s*:)|(=\s*(value))` — matching a value after `=` with NO label.
  const pattern = new RegExp(
    `\\b(?:${cfg.labelPattern})\\s*(?:${separator})\\s*(${cfg.valuePattern})\\b`,
    'gi',
  )
  const valueExtractor = new RegExp(`(${cfg.valuePattern})`, 'i')
  const validate = cfg.validateValue
    ? (match: string): boolean => {
        const m = valueExtractor.exec(match)
        if (m === null) return false
        return cfg.validateValue?.(m[1]) ?? false
      }
    : undefined
  return {
    id: cfg.id,
    label: cfg.label,
    severity: cfg.severity,
    category: cfg.category,
    baseSensitivity: cfg.baseSensitivity,
    isContextSignal: cfg.isContextSignal,
    maskToken: cfg.maskToken,
    pattern,
    validate,
  }
}

// Value pattern used by the identifier-style contextual detectors (MRN, member,
// claim, patient, account, license). Uppercase-alphanumeric-plus-hyphen, 4–20
// chars, MUST contain at least one digit — the digit lookahead is what stops
// "Member ID John Doe" from wrongly capturing "John". The `i` flag on the outer
// pattern makes the letters case-insensitive.
const ALNUM_ID_WITH_DIGIT = '(?=[A-Z0-9-]*\\d)[A-Z0-9-]{4,20}'

// Expands each ASCII letter in `s` to a case-insensitive character class so
// the resulting regex fragment is case-INSENSITIVE without needing the `i`
// flag. Used by patient_name / street_address, which compile with `g` only
// (not `gi`) so their value patterns can rely on case-sensitive `[A-Z]` to
// discriminate proper names / capitalized street words from prose. Non-letter
// characters (whitespace, `\s`, `+`, etc.) are passed through unchanged.
function ci(s: string): string {
  return s.replace(/[A-Za-z]/g, (c) => `[${c.toUpperCase()}${c.toLowerCase()}]`)
}

// Medication dictionary is compiled into a single alternation; all entries are
// plain lower-case words so no regex-escaping is needed.
const MEDICATION_PATTERN = new RegExp(`\\b(?:${MEDICATIONS.join('|')})\\b`, 'gi')

// V1.3.1 — English month names (abbreviated + full) for written-month DOB
// forms. Matched case-insensitively (the DOB rule compiles with `gi`).
const MONTH_NAME =
  'Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|' +
  'Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?'
// DOB date VALUE: numeric US (M/D or D/M), ISO Y-M-D, and written-month forms
// in BOTH month-first ("Sep/20/1988", "September 20, 1988") and day-first
// ("20-Sep-1988", "23 December 2017") order, over space / slash / hyphen / dot
// separators. `isValidDobDate` does calendar validation + day/month resolution.
const DOB_VALUE = [
  '\\d{1,2}[./-]\\d{1,2}[./-]\\d{2,4}',
  '\\d{4}[-.]\\d{1,2}[-.]\\d{1,2}',
  `(?:${MONTH_NAME})[\\s./-]+\\d{1,2},?[\\s./-]+\\d{2,4}`,
  `\\d{1,2}[\\s./-]+(?:${MONTH_NAME})[\\s./-]+\\d{2,4}`,
].join('|')

// `anthropic_key` is intentionally ordered before `openai_key`: an Anthropic key
// (`sk-ant-...`) also satisfies the broader OpenAI pattern, so listing the more
// specific rule first lets mergeOverlapping keep the correct label on a tie.
//
// V1.1: each rule carries `category` and `baseSensitivity`. `severity` is kept
// (drives overlap-merge ranking and backward compatibility); `baseSensitivity`
// is what the preview UX and combination scoring reason about. For CRITICAL/HIGH
// identifiers we use severity 'high' to match the existing SSN/CC precedent from
// V1; CLINICAL_CONTEXT rules use severity 'low' so any accidental overlap with
// an identifier resolves to the identifier winning the merge.
export const RULES: DetectorRule[] = [
  // ─── V1 detectors (unchanged behavior; taxonomy added in PR 1) ─────────────
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

  // ─── V1.1: PROVIDER_ID ────────────────────────────────────────────────────
  // Ordered BEFORE phone/email/etc. so that a bare 10-digit sequence which
  // satisfies both the phone regex and the NPI checksum resolves to NPI
  // (more specific — has a validated check digit) on the mergeOverlapping tie.
  {
    id: 'npi',
    label: 'NPI',
    severity: 'high',
    category: DetectorCategory.PROVIDER_ID,
    baseSensitivity: SensitivityLevel.HIGH,
    maskToken: '[NPI]',
    pattern: /\b\d{10}\b/g,
    validate: isValidNpi,
  },
  {
    id: 'dea',
    label: 'DEA Number',
    severity: 'high',
    category: DetectorCategory.PROVIDER_ID,
    baseSensitivity: SensitivityLevel.HIGH,
    maskToken: '[DEA]',
    pattern: /\b[A-Z]{2}\d{7}\b/g,
    validate: isValidDea,
  },

  // ─── V1.1: IDENTITY ────────────────────────────────────────────────────────
  // V1.3.1 — DOB recall expansion. Adds `born` / `born on` phrasing,
  // `Birth Date` / `Birthdate`, and ISO `Y-M-D` dates, and now VALIDATES
  // the date as a real calendar date + plausible birth year
  // (`isValidDobDate`). Still strictly label-anchored: contextualRule
  // permits only whitespace / `:` / `#` between the label and the date,
  // so an ordinary unlabelled date (an appointment, a meeting) is never a
  // DOB. `\bborn` does not match inside `newborn` / `stillborn` / `reborn`
  // (no word boundary), and "born in 2019" (a bare year, no full date)
  // fails the value pattern.
  contextualRule({
    id: 'date_of_birth',
    label: 'Date of Birth',
    category: DetectorCategory.IDENTITY,
    baseSensitivity: SensitivityLevel.HIGH,
    maskToken: '[DOB]',
    severity: 'high',
    labelPattern: 'born(?:\\s+on)?|DOB|D\\.O\\.B\\.?|Date\\s+of\\s+Birth|Birth\\s*Date',
    valuePattern: DOB_VALUE,
    validateValue: isValidDobDate,
  }),
  {
    id: 'phone',
    label: 'Phone Number',
    severity: 'high',
    category: DetectorCategory.IDENTITY,
    baseSensitivity: SensitivityLevel.HIGH,
    maskToken: '[PHONE]',
    pattern: /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
    validate: isPlausiblePhone,
  },
  {
    id: 'email',
    label: 'Email Address',
    severity: 'high',
    category: DetectorCategory.IDENTITY,
    baseSensitivity: SensitivityLevel.HIGH,
    maskToken: '[EMAIL]',
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  },

  // ─── V1.1 PR 3: patient names + street addresses (contextual only) ────────
  //
  // Both detectors are label-anchored. Patient names have NO structural fallback
  // (free-prose names are out of scope for V1.1 — the miss rate on unlabeled names
  // is preferable to the false-positive rate any bare-name heuristic produces).
  // Street addresses accept EITHER a label anchor OR a structural anchor (leading
  // house number + street-type suffix). The house number is what separates a real
  // address from a street name mentioned in prose ("We met on Main Street").
  //
  // Provider-side labels (`Provider`, `Physician`, `Dr`, `Referring`) are
  // intentionally NOT in the patient_name label set: provider names are not PHI,
  // and NPI/DEA already cover provider identifiers. Masking provider names would
  // add noise without protecting anything.
  //
  // Separator is REQUIRED (`:`, `-`, `–`, `=`) — a bare-label prefix like
  // "the patient Sarah Khan reported…" would otherwise over-fire.
  //
  // patient_name is compiled with the `g` flag only (NOT `gi`). We rely on
  // case-sensitive value matching so a proper capitalized name token
  // (e.g. `Sarah`, `O'Brien`, `Smith-Jones`) is distinguishable from an
  // uppercase acronym or a lowercase word that follows it. Adding the `i` flag
  // would collapse that distinction — `[A-Z]` would also match `[a-z]`, causing
  // "Patient: seen today" to fire and "Patient: Sarah Khan DOB: 01/02/1980"
  // to swallow `DOB` as if it were a name token. That is why we DO NOT use
  // contextualRule here (which is `gi` by design for its identifier detectors):
  // instead we pin case-INSENSITIVITY to the label alternatives explicitly by
  // expanding each letter to a `[Xx]` character class via the `ci()` helper,
  // so `Patient:`, `patient:`, and `PATIENT:` all match while the value
  // remains case-sensitive.
  //
  // A NAME_WORD is `[A-Z]` followed by either at least one lowercase letter
  // (`Sarah`, `Khan`), an apostrophe segment (`O'Brien`), or a hyphenated
  // segment (`Smith-Jones`). An acronym like `DOB` fails because `[A-Z]` is
  // not followed by any of those. A middle initial is `[A-Z]\.` (allowed as
  // a non-terminal token only). Value = 2..4 tokens or `Last, First [Middle]`.
  (() => {
    // The bare `Name` alternative from the spec is intentionally OMITTED here:
    // "Provider Name: Alice Wong" would otherwise match `Name: Alice Wong`
    // (with `Provider ` sitting harmlessly to the left of the word boundary),
    // silently masking a provider name. The require-`Patient` prefix in
    // `Patient Name` disambiguates. `Name` alone is also weak signal —
    // "Product Name:", "File Name:", "User Name:" are all common non-medical
    // forms. Removing it costs one line of the issue's positive-example
    // wishlist and buys precision on the primary risk (provider-side capture).
    const label =
      `${ci('Patient')}\\s+${ci('Name')}|` +
      `${ci('Patient')}|${ci('Member')}|` +
      `${ci('Insured')}|${ci('Subscriber')}|${ci('Guarantor')}|${ci('Pt')}`
    const nameWord = "[A-Z](?:[a-z]+|'[A-Za-z]+)(?:[-'][A-Za-z]+)*"
    const nameToken = `(?:${nameWord}|[A-Z]\\.)`
    const value =
      `(?:${nameWord},\\s+${nameWord}(?:\\s+${nameWord})?` +
      `|(?:${nameToken}\\s+){1,3}${nameWord})`
    return {
      id: 'patient_name' as const,
      label: 'Person Name',
      severity: 'high' as const,
      category: DetectorCategory.IDENTITY,
      baseSensitivity: SensitivityLevel.HIGH,
      maskToken: '[PERSON_NAME]',
      pattern: new RegExp(`\\b(?:${label})\\s*[:=–-]\\s*${value}\\b`, 'g'),
    }
  })(),
  // ─── V1.3.1: precision-focused patient-name recall additions ──────────────
  // Three NARROW rules (no blanket two-token title-case match, no broad
  // proximity): (1) strong "<label> Name" with an OPTIONAL separator,
  // (2) honorific + surname, (3) a name IMMEDIATELY adjacent to a strong
  // identifier label. Each is independently corpus-tested; see
  // tests/name-dob-recall.test.ts and the grown precision corpus.
  (() => {
    // (1) Strong patient-name labels that ALREADY contain "Name" are
    // unambiguous enough to allow an OPTIONAL separator, so
    // "Patient Name John Smith" (no colon) warns like "Patient Name: John
    // Smith". Bare "Patient"/"Member" still REQUIRE a separator (the
    // patient_name rule above). Provider-side "Name" is excluded because
    // every alternative pins an explicit patient-side prefix.
    const strong =
      `${ci('Patient')}\\s+${ci('Name')}|` +
      `${ci('Patient')}['’]${ci('s')}\\s+${ci('Name')}|` +
      `${ci('Pt')}\\s+${ci('Name')}|` +
      `${ci('Member')}\\s+${ci('Name')}|` +
      `${ci('Insured')}\\s+${ci('Name')}|` +
      `${ci('Subscriber')}\\s+${ci('Name')}|` +
      `${ci('Guarantor')}\\s+${ci('Name')}|` +
      `${ci('Beneficiary')}\\s+${ci('Name')}`
    const nameWord = "[A-Z](?:[a-z]+|'[A-Za-z]+)(?:[-'][A-Za-z]+)*"
    const nameToken = `(?:${nameWord}|[A-Z]\\.)`
    const value =
      `(?:${nameWord},\\s+${nameWord}(?:\\s+${nameWord})?` +
      `|(?:${nameToken}\\s+){1,3}${nameWord})`
    return {
      id: 'patient_name_labeled' as const,
      label: 'Person Name',
      severity: 'high' as const,
      category: DetectorCategory.IDENTITY,
      baseSensitivity: SensitivityLevel.HIGH,
      maskToken: '[PERSON_NAME]',
      pattern: new RegExp(`\\b(?:${strong})\\s*[:=–-]?\\s*${value}\\b`, 'g'),
    }
  })(),
  (() => {
    // (2) Honorific + surname — a strong patient-name signal in prose
    // ("Mrs. Khan", "Mr. Thompson"). Honorific is CASE-SENSITIVE so "ms"
    // (milliseconds) never matches; provider titles (Dr, Prof) are absent
    // by design. A short, TESTED exclusion drops known non-person
    // "<Honorific> <Capital>" forms seen in the negative corpus. This is
    // NOT a bare two-token name match — an explicit honorific is required.
    const NON_PERSON = new Set(['Bumble'])
    return {
      id: 'patient_name_honorific' as const,
      label: 'Person Name',
      severity: 'high' as const,
      category: DetectorCategory.IDENTITY,
      baseSensitivity: SensitivityLevel.HIGH,
      maskToken: '[PERSON_NAME]',
      pattern: /\b(?:Mrs|Mr|Miss|Ms|Mx)\.?\s+[A-Z][a-z]+(?:[-'][A-Z][a-z]+)?(?:\s+[A-Z][a-z]+)?\b/g,
      validate: (m: string): boolean => {
        const s = /^(?:Mrs|Mr|Miss|Ms|Mx)\.?\s+([A-Z][a-z]+)/.exec(m)
        return s !== null && !NON_PERSON.has(s[1])
      },
    }
  })(),
  (() => {
    // (3) A 2–3 token proper name IMMEDIATELY before a strong identifier
    // label ("John Smith, MRN 12345678"). TIGHT adjacency via a lookahead
    // (optional comma + one run of whitespace, then the identifier) — NOT
    // broad proximity. Requires ≥2 name tokens so a lone capitalized verb
    // ("Order SSN…") can't match. The identifier itself is caught by its
    // own rule; this rule ensures the NAME is detected too, so an MRN
    // warning never conceals a missed name.
    const nameWord = "[A-Z](?:[a-z]+|'[A-Za-z]+)(?:[-'][A-Za-z]+)*"
    const idLabel = 'MRN|SSN|DOB|Member\\s*(?:ID|#)|Account\\s*(?:No\\.?|#)|Claim\\s*#'
    return {
      id: 'patient_name_id_adjacent' as const,
      label: 'Person Name',
      severity: 'high' as const,
      category: DetectorCategory.IDENTITY,
      baseSensitivity: SensitivityLevel.HIGH,
      maskToken: '[PERSON_NAME]',
      pattern: new RegExp(
        `\\b${nameWord}(?:\\s+${nameWord}){1,2}(?=\\s*,?\\s+(?:${idLabel})\\b)`,
        'g',
      ),
    }
  })(),
  (() => {
    // Alternation of two forms, either sufficient:
    //   1. STRUCTURAL — leading house number + 1..4 capitalized street-name words
    //      + a suffix from a fixed set + optional unit indicator. The leading
    //      `\d{1,6}` is the discriminator: "We met on Main Street" has no number
    //      and MUST NOT fire.
    //   2. LABELED — `Address` / `Addr` / `Home Address` + required separator +
    //      rest of line (excluding line breaks). The required separator prevents
    //      "Meeting Address in the room" from over-firing.
    //
    // Also compiled with `g` (no `i`): structural detection depends on the
    // street-name words being capitalized so a lowercase-prose "we met at 123
    // main street" does NOT trip the structural form. The labeled form's label
    // alternatives are made case-INSENSITIVE via `ci()` (`Address`, `address`,
    // `ADDRESS`, `Home Address`, `HOME ADDRESS` all match).
    const suffixes =
      'Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|' +
      'Court|Ct|Way|Place|Pl|Terrace|Ter|Circle|Cir|Highway|Hwy'
    const structural =
      `\\d{1,6}\\s+(?:[A-Z][A-Za-z]{0,20}\\s+){1,4}(?:${suffixes})\\.?` +
      `(?:,?\\s+(?:(?:Apt|Suite|Ste|Unit|#)\\s*[A-Za-z0-9-]+|\\d{1,5}[A-Za-z]?))?`
    const labeled =
      `(?:${ci('Home')}\\s+${ci('Address')}|${ci('Address')}|${ci('Addr')})` +
      `\\s*[:=–-]\\s*[^\\n\\r]+`
    return {
      id: 'street_address' as const,
      label: 'Street Address',
      severity: 'high' as const,
      category: DetectorCategory.IDENTITY,
      baseSensitivity: SensitivityLevel.HIGH,
      maskToken: '[ADDRESS]',
      pattern: new RegExp(`\\b(?:${structural}|${labeled})`, 'g'),
    }
  })(),

  // ─── V1.1: HEALTHCARE_PATIENT_ID ──────────────────────────────────────────
  contextualRule({
    id: 'mrn',
    label: 'MRN',
    category: DetectorCategory.HEALTHCARE_PATIENT_ID,
    baseSensitivity: SensitivityLevel.CRITICAL,
    maskToken: '[MRN]',
    severity: 'high',
    labelPattern: 'MRN|Medical\\s+Record\\s*(?:No\\.?|Number|#)?',
    valuePattern: ALNUM_ID_WITH_DIGIT,
  }),
  contextualRule({
    id: 'member_id',
    label: 'Member ID',
    category: DetectorCategory.HEALTHCARE_PATIENT_ID,
    baseSensitivity: SensitivityLevel.HIGH,
    maskToken: '[MEMBER_ID]',
    severity: 'high',
    labelPattern: 'Member\\s+ID|Subscriber\\s+ID',
    valuePattern: ALNUM_ID_WITH_DIGIT,
  }),
  contextualRule({
    id: 'claim_number',
    label: 'Claim Number',
    category: DetectorCategory.HEALTHCARE_PATIENT_ID,
    baseSensitivity: SensitivityLevel.HIGH,
    maskToken: '[CLAIM]',
    severity: 'high',
    labelPattern: 'Claim\\s*(?:#|No\\.?|Number)',
    valuePattern: ALNUM_ID_WITH_DIGIT,
  }),
  contextualRule({
    id: 'rx_number',
    label: 'Prescription Number',
    category: DetectorCategory.HEALTHCARE_PATIENT_ID,
    baseSensitivity: SensitivityLevel.HIGH,
    maskToken: '[RX]',
    severity: 'high',
    labelPattern: 'Rx\\s*(?:#|No\\.?|Number)|Prescription\\s*(?:#|No\\.?|Number)',
    // Rx numbers are typically digits-only; keeping the value strict here avoids
    // capturing dose fragments like "100mg" if someone writes "Rx: 100mg".
    valuePattern: '\\d{6,12}',
  }),
  contextualRule({
    id: 'patient_id',
    label: 'Patient ID',
    category: DetectorCategory.HEALTHCARE_PATIENT_ID,
    baseSensitivity: SensitivityLevel.HIGH,
    maskToken: '[PATIENT_ID]',
    severity: 'high',
    labelPattern: 'Patient\\s+ID|Pt\\.?\\s*ID',
    valuePattern: ALNUM_ID_WITH_DIGIT,
  }),

  // ─── V1.1: GOVERNMENT_FINANCIAL ───────────────────────────────────────────
  contextualRule({
    id: 'account_number',
    label: 'Account Number',
    category: DetectorCategory.GOVERNMENT_FINANCIAL,
    baseSensitivity: SensitivityLevel.HIGH,
    maskToken: '[ACCOUNT]',
    severity: 'high',
    labelPattern: 'Account\\s*(?:#|No\\.?|Number)|Acct\\.?\\s*(?:#|No\\.?|Number)?',
    valuePattern: ALNUM_ID_WITH_DIGIT,
  }),
  contextualRule({
    id: 'license_number',
    label: 'License Number',
    category: DetectorCategory.GOVERNMENT_FINANCIAL,
    baseSensitivity: SensitivityLevel.HIGH,
    maskToken: '[LICENSE]',
    severity: 'high',
    labelPattern: 'License\\s*(?:#|No\\.?|Number)?|DL\\.?\\s*(?:#|No\\.?|Number)?',
    valuePattern: ALNUM_ID_WITH_DIGIT,
  }),

  // ─── V1.1: CLINICAL_CONTEXT ───────────────────────────────────────────────
  // All context detectors have severity 'low' (loses overlap-merges to any
  // identifier finding) and baseSensitivity LOW (scored to LOW effective).
  {
    id: 'icd10',
    label: 'ICD-10 Code',
    severity: 'low',
    category: DetectorCategory.CLINICAL_CONTEXT,
    baseSensitivity: SensitivityLevel.LOW,
    isContextSignal: true,
    maskToken: '[ICD]',
    pattern: /\b[A-Z]\d{2}(?:\.[A-Z0-9]{1,4})?\b/g,
  },
  contextualRule({
    id: 'cpt',
    label: 'CPT Code',
    category: DetectorCategory.CLINICAL_CONTEXT,
    baseSensitivity: SensitivityLevel.LOW,
    maskToken: '[CPT]',
    severity: 'low',
    isContextSignal: true,
    labelPattern: 'CPT(?:\\s*code)?|Current\\s+Procedural\\s+Terminology',
    valuePattern: '\\d{5}',
  }),
  {
    id: 'medication',
    label: 'Medication',
    severity: 'low',
    category: DetectorCategory.CLINICAL_CONTEXT,
    baseSensitivity: SensitivityLevel.LOW,
    isContextSignal: true,
    maskToken: '[MEDICATION]',
    pattern: MEDICATION_PATTERN,
  },
]
