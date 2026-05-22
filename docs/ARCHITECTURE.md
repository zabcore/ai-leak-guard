# AI Leak Guard — Architecture

## Core principle
Everything runs locally in the user's browser. No backend, no database, no telemetry, no user text ever leaves the device. One optional outbound call: daily fetch of a static rules JSON file from a CDN.

## Tech stack
- **Language:** TypeScript
- **Bundler:** Vite (with `vite-plugin-web-extension` or similar)
- **Test runner:** Vitest
- **Linter:** ESLint with TypeScript plugin
- **Formatter:** Prettier
- **Manifest:** Chrome Manifest V3
- **UI:** Vanilla TypeScript + HTML for popup, Shadow DOM for in-page toast (no React in V1 — bundle size matters for extensions)

## Project structure
```
ai-leak-guard/
├── manifest.json                 # Chrome MV3 manifest
├── package.json
├── tsconfig.json
├── vite.config.ts
├── .eslintrc.json
├── .prettierrc
├── src/
│   ├── detector/
│   │   ├── engine.ts             # Pure detection function, no DOM/Chrome APIs
│   │   ├── rules.ts              # Bundled default rules
│   │   ├── validators.ts         # Luhn, entropy, SSN exclusions
│   │   └── types.ts              # TypeScript types for Finding, Rule
│   ├── content/
│   │   ├── index.ts              # Content script entry, paste interception
│   │   ├── adapters/
│   │   │   ├── base.ts           # Adapter interface
│   │   │   ├── chatgpt.ts        # ChatGPT-specific input insertion
│   │   │   ├── claude.ts         # Claude.ai-specific
│   │   │   ├── gemini.ts         # Gemini-specific
│   │   │   ├── perplexity.ts     # Perplexity-specific
│   │   │   └── copilot.ts        # Microsoft Copilot-specific
│   │   ├── masker.ts             # Apply masks to text given findings
│   │   └── toast.ts              # Shadow DOM toast with Undo
│   ├── background/
│   │   ├── index.ts              # Service worker entry
│   │   └── rules-updater.ts      # Daily rules fetch from CDN
│   ├── popup/
│   │   ├── index.html
│   │   ├── popup.ts              # Counter display, on/off toggle
│   │   └── popup.css
│   └── shared/
│       ├── storage.ts            # Thin wrapper over chrome.storage.local
│       └── counter.ts            # Local leak counter logic
├── tests/
│   ├── detector.test.ts          # Unit tests for detection engine
│   ├── validators.test.ts        # Luhn, entropy, SSN edge cases
│   └── fixtures/
│       └── sample-payloads.ts    # Fake SSNs, fake keys, fake credit cards
├── docs/                         # (this folder)
└── .github/
    └── workflows/                # CI/CD
```

## Detection engine contract
The detector is a **pure function**:

```typescript
function detect(text: string, rules: Rule[]): Finding[]
```

- No DOM access
- No Chrome API access
- No network access
- Testable in Node with Vitest
- Deterministic: same input always produces same output

This separation is critical. The detector must be unit-testable in CI without a browser.

## Detection rules (V1)
Each rule has:
- `id`: stable identifier
- `label`: human-readable name shown in toast
- `pattern`: RegExp
- `validate`: optional function for post-pattern checks (e.g., Luhn for credit cards)
- `severity`: critical | high | medium

V1 rules:
- `aws_access_key`: `\bAKIA[0-9A-Z]{16}\b`
- `github_pat`: `\b(ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{36,}\b`
- `openai_key`: `\bsk-[A-Za-z0-9]{20,}\b`
- `anthropic_key`: `\bsk-ant-[A-Za-z0-9_-]{20,}\b`
- `stripe_key`: `\b(sk|pk|rk)_(live|test)_[A-Za-z0-9]{20,}\b`
- `google_api_key`: `\bAIza[0-9A-Za-z_-]{35}\b`
- `jwt`: 3-part dot-separated base64 structure
- `private_key_block`: `-----BEGIN (RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----` through `-----END`
- `ssn`: `\b(?!000|666|9\d{2})\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b`
- `credit_card`: 13–19 digit groups + Luhn validation
- `generic_secret`: `(password|secret|token|api[_-]?key)\s*[:=]\s*["']?[A-Za-z0-9+/=_-]{16,}` + entropy > 3.5

## Site adapter contract
Each AI site has different input editors (contenteditable, ProseMirror, Lexical, etc.). The adapter interface:

```typescript
interface SiteAdapter {
  domain: string[];                    // ["chatgpt.com", "chat.openai.com"]
  isInputElement(el: Element): boolean;
  insertText(el: Element, text: string): boolean;  // returns success
  replaceContents(el: Element, text: string): boolean;
}
```

Default fallback uses `document.execCommand('insertText')` which still works on Chrome for contenteditable inputs even though it's deprecated. Site-specific adapters override when needed.

## Paste interception flow
1. Content script attaches a **capture-phase** `paste` event listener on `document`
2. When fired, read `clipboardData.getData('text/plain')`
3. Pass to detector
4. If `findings.length === 0`, do nothing — let the original paste through
5. If findings exist:
   - `e.preventDefault()` and `e.stopPropagation()`
   - Compute masked text via `masker.ts`
   - Use site adapter to insert masked text into active input
   - Show toast with Undo
   - Increment local counter

## Storage schema
`chrome.storage.local`:
```typescript
{
  counters: {
    total: number,
    byType: Record<string, number>,    // ruleId -> count
    byDay: Record<string, number>,     // YYYY-MM-DD -> count
  },
  prefs: {
    enabled: boolean,
    rulesUpdatedAt: number,            // timestamp
  },
  rules: Rule[] | null,                // cached remote rules, null = use bundled
}
```

## Rules update mechanism
- Background service worker has a `chrome.alarms` that fires every 12 hours
- Fetches `https://cdn.aileakguard.com/rules/v1.json` (TBD — Cloudflare Pages or GitHub Pages)
- Validates each pattern compiles and runs in <5ms against a fuzz string (anti-ReDoS)
- On success, caches in `chrome.storage.local.rules`
- On failure, keeps the previously cached rules (or falls back to bundled)
- This is **the only outbound network call** the extension makes

## Permissions (Manifest V3)
Minimum required:
- `storage` — for local counter and prefs
- `clipboardRead` — for reading pasted text
- `scripting` — for content scripts
- `alarms` — for rules update schedule

`host_permissions`:
- `https://chatgpt.com/*`
- `https://chat.openai.com/*`
- `https://claude.ai/*`
- `https://gemini.google.com/*`
- `https://www.perplexity.ai/*`
- `https://copilot.microsoft.com/*`

No broad `<all_urls>` permission. Tight host list reduces Chrome Web Store review friction.

## Security considerations
- Never use `eval()` or `new Function()` on remote rule patterns
- Validate every remote regex against a fuzz string with a timeout before compiling
- Toast UI uses Shadow DOM with `mode: 'closed'` so target sites can't restyle or read it
- All extension messaging stays within the extension — no `window.postMessage` to page context
- No external scripts loaded at runtime (CSP-compliant by default)

## Performance budget
- Detection on a typical paste (<5KB): under 5ms
- Detection on a large paste (50KB): under 50ms (acceptable for paste interactions)
- Extension bundle size: under 200KB total
- Memory footprint: under 5MB resident

## What this architecture explicitly does NOT include in V1
- React or any UI framework
- Server backend
- User authentication
- Database
- Analytics or telemetry
- AI-based classification (ML models, embeddings)
- Cross-device sync
- Browsers other than Chrome
