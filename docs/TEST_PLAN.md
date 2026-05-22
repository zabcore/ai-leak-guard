# AI Leak Guard — Manual Test Plan

## When to run this
Run this checklist before submitting any new version to the Chrome Web Store. Also run it after any change to the detector, the content script, or a site adapter.

Run time: about 15 minutes.

## Setup
1. Build the extension: `npm run build`
2. Open Chrome → `chrome://extensions`
3. Enable "Developer mode" (top right)
4. Click "Load unpacked" → select the `dist/` folder
5. Confirm the AI Leak Guard icon appears in the toolbar
6. Click the icon — confirm the popup opens and shows "0 leaks prevented"

## Test payloads
Use these fake-but-realistic values. **Never use real secrets.**

| Type | Test value |
|------|-----------|
| SSN | `John Smith SSN 123-45-6789` |
| Credit card (Visa) | `Card: 4532015112830366` (valid Luhn) |
| Credit card (Mastercard) | `5425233430109903` (valid Luhn) |
| Invalid credit card | `4532015112830367` (Luhn fail — should NOT trigger) |
| AWS access key | `AKIAIOSFODNN7EXAMPLE` |
| OpenAI key | `sk-proj-abc123def456ghi789jkl012mno345pqr678` |
| Anthropic key | `sk-ant-api03-abc123def456ghi789jkl012mno345` |
| GitHub PAT | `ghp_abcdefghijklmnopqrstuvwxyz0123456789` |
| Stripe live key | `sk_live_abcdefghijklmnopqrstuvwx` |
| Google API key | `AIzaSyDxVlAabc123def456ghi789jkl012mno3` |
| JWT | `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123def456ghi789` |
| Private key | `-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----` |
| Generic secret | `password = "MyS3cretP@ssw0rd2024"` |
| Plain text (no detection) | `What's the capital of France?` |

## Site-by-site checks

### ChatGPT (chatgpt.com)
- [ ] Open chatgpt.com, log in
- [ ] Paste the SSN payload → toast appears, text shows `[SSN]` placeholder
- [ ] Click "Undo" in toast → original SSN restored in input box
- [ ] Paste the AWS key → toast appears, text shows `[AWS_ACCESS_KEY]` placeholder
- [ ] Paste the plain text payload → no toast, text inserts normally
- [ ] Paste a multi-finding payload (SSN + credit card + AWS key together) → toast says "3 sensitive items masked"
- [ ] Send the masked prompt → ChatGPT receives the masked version (verify in conversation)

### Claude (claude.ai)
- [ ] Open claude.ai, log in
- [ ] Paste the OpenAI key → toast appears, masked correctly
- [ ] Paste the Anthropic key → toast appears, masked correctly
- [ ] Paste the JWT → toast appears, masked correctly
- [ ] Click Undo → original text restored
- [ ] Paste plain text → no toast, no masking

### Gemini (gemini.google.com)
- [ ] Open gemini.google.com
- [ ] Paste the credit card payload → toast appears, masked
- [ ] Paste the invalid Luhn credit card → no toast (Luhn validation worked)
- [ ] Paste the private key block → toast appears, masked

### Perplexity (perplexity.ai)
- [ ] Open perplexity.ai
- [ ] Paste any single sensitive payload → toast appears, masked
- [ ] Plain text paste works normally

### Microsoft Copilot (copilot.microsoft.com)
- [ ] Open copilot.microsoft.com
- [ ] Paste any single sensitive payload → toast appears, masked
- [ ] Plain text paste works normally

## Functional checks

### Counter
- [ ] After the tests above, click the extension icon
- [ ] Counter shows total roughly matching the number of detections (within a few — Undo behavior may adjust this)
- [ ] Counter persists after closing and reopening the browser

### On/off toggle
- [ ] In the popup, toggle the extension OFF
- [ ] Paste a sensitive payload into ChatGPT → no toast, text inserts unmodified
- [ ] Toggle back ON
- [ ] Paste again → toast appears

### Undo behavior
- [ ] Paste a finding → toast appears
- [ ] Click Undo within 6 seconds → original text restored, counter does NOT include this paste
- [ ] Paste a finding → toast appears
- [ ] Wait for toast to auto-dismiss (6 seconds) → text remains masked, counter includes this paste

### Edge cases
- [ ] Paste a 50KB block of text containing one buried SSN → SSN is detected without UI freezing
- [ ] Paste a 50KB block of plain text (no findings) → no toast, no perceptible delay
- [ ] Paste text into a non-AI website (e.g., google.com search box) → no toast, no interception (host permissions are scoped)
- [ ] Paste while a previous toast is still visible → previous toast dismisses, new toast appears
- [ ] Rapid-paste the same content 5 times → counter increments correctly each time

### Site stability
- [ ] After all tests, refresh each AI tool page → site still works normally
- [ ] Send a normal (non-sensitive) message on each site → sends correctly, AI responds

## False positive checks
These should produce **NO toast** (they look sensitive but aren't):

- [ ] `My phone number is 123-456-7890` (looks like SSN format but isn't)
- [ ] `Order #5425233430109904` (16 digits but fails Luhn — should not match credit card)
- [ ] `Use the password field below` (mentions "password" but no actual secret)
- [ ] `API key documentation here` (mentions "API key" but no actual key value)
- [ ] `AKIA is a common AWS prefix` (mentions AKIA but not in key format)

## Pass criteria
All checkboxes above must be checked before submitting to the Chrome Web Store. If any test fails, file an issue with:
- Which test failed
- The exact payload used
- Expected behavior
- Actual behavior
- Browser version
- Extension version
- Screenshot if relevant
