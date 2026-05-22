# AI Leak Guard — Product Requirements Document

## One-line vision
Protect users from accidentally leaking sensitive information into AI tools.

## Promise
Before you paste sensitive data into ChatGPT, Claude, Gemini, or any AI tool — AI Leak Guard catches it and masks it locally, on your device, before it leaves your browser.

## Why this exists
People paste sensitive information into AI tools every day: API keys, SSNs, credit cards, patient notes, employee data, contracts. Most don't realize where the data goes, whether it's stored, or whether it trains future models. Existing enterprise tools are expensive, heavy, and built for IT teams at large companies. Individuals and small businesses have nothing.

## V1 product
A free Chrome extension. No backend. No database. No accounts. No telemetry in V1. Everything runs locally in the user's browser.

## User flow
1. User opens an AI tool (ChatGPT, Claude, Gemini, Perplexity, Copilot)
2. User pastes content into the prompt box
3. Extension intercepts the paste before it reaches the AI tool
4. Detection engine scans the text locally for sensitive patterns
5. Sensitive items are replaced with placeholders (e.g., `[SSN]`, `[AWS_KEY]`)
6. Masked version is inserted into the prompt box
7. Small toast appears: "2 sensitive items masked. Undo?"
8. Local counter increments

## V1 detection scope (high precision only)
- AWS access keys (`AKIA...`)
- GitHub tokens (`ghp_`, `gho_`, `ghs_`)
- OpenAI keys (`sk-...`)
- Anthropic keys (`sk-ant-...`)
- Stripe keys (`sk_live_`, `pk_live_`, etc.)
- Google API keys (`AIza...`)
- JWTs (3-part dot structure)
- Private key blocks (`-----BEGIN ... PRIVATE KEY-----`)
- US Social Security Numbers (with exclusion rules for invalid prefixes)
- Credit cards (with Luhn validation)
- Generic high-entropy secrets in assignment patterns (`password=`, `token=`, etc.)

## V1 explicitly excludes
- Name detection
- Generic email detection
- Generic phone number detection
- Generic address detection

These are excluded because they produce too many false positives at V1's confidence threshold. They may be added later as opt-in detection packs.

## Supported sites at V1
- ChatGPT (chatgpt.com, chat.openai.com)
- Claude (claude.ai)
- Gemini (gemini.google.com)
- Perplexity (perplexity.ai)
- Microsoft Copilot (copilot.microsoft.com)

## UX principles
- Silent masking by default, not blocking modals
- Toast notification with one-click Undo
- Local counter visible in the popup ("X leaks prevented")
- Never break the user's flow
- Never break the AI site's input

## Privacy promise (non-negotiable)
- No user text ever leaves the browser in V1
- No backend, no database, no analytics
- No accounts, no registration
- One outbound network call permitted: daily fetch of static detection rules JSON from a CDN (one-way only)

## Success criteria for V1
- Installs successfully from Chrome Web Store
- Works on at least ChatGPT and Claude
- Masks all V1 detection categories correctly
- Does not break paste flow on any supported site
- Undo restores original text correctly
- Local counter updates accurately
- Users understand the privacy promise from the onboarding screen

## What V1 explicitly does not include
- User accounts or login
- Team dashboards
- Admin policies
- Audit reports
- HIPAA/compliance workflows
- Backend APIs
- AI-based classification
- Browser support beyond Chrome
- Desktop or IDE integrations

## Monetization (post-V1, not in scope here)
Free extension forever. Paid tier later for teams: dashboards, policies, industry packs, audit reports. $7–9/user/month range.
