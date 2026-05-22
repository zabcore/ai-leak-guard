# AI Leak Guard — Privacy Promise

## The promise, in one sentence
Your text never leaves your browser. Detection and masking happen locally on your device.

## What we do NOT collect
AI Leak Guard does not collect, transmit, store, or have access to any of the following:

- The text you paste into AI tools
- Sensitive items detected by the extension (matched values, raw or hashed)
- Your prompts to AI tools
- AI tool responses
- File contents
- Names, email addresses, phone numbers, or any personal identifiers
- Patient information, client information, or customer information
- API keys, credentials, or secrets — even after they've been masked
- Browsing history
- URLs of pages you visit
- Cookies or session data
- IP addresses
- Device fingerprints
- Usage analytics tied to your identity

## What stays local on your device
The following data is stored only in your browser, in `chrome.storage.local`, and is never sent anywhere:

- The local leak counter (e.g., "47 leaks prevented")
- Your on/off toggle preference
- A cached copy of the detection rules
- Timestamps of when rules were last updated

This data is accessible only to the extension itself, on your device. Uninstalling the extension removes it.

## Outbound network requests
AI Leak Guard makes exactly **one type of outbound request**, and only for one purpose:

- **Daily rules fetch:** Once every 12 hours, the extension downloads a JSON file containing updated detection patterns from a static CDN. This is a one-way download. No data about you, your usage, your text, or your device is sent in this request beyond what your browser normally includes in any HTTPS request (user agent, IP at the network level — neither logged by us).

That's the only outbound traffic. There is no analytics endpoint, no telemetry server, no error reporting service, no third-party SDK that phones home.

## No accounts, no registration
AI Leak Guard does not require an account, email address, or any registration to use. There is nothing to sign up for.

## No third parties
The extension does not load code, scripts, fonts, or assets from any third-party service at runtime. It does not include analytics SDKs (no Google Analytics, no Mixpanel, no PostHog, no Sentry). It does not embed third-party widgets.

## Permissions explained
The extension requests the following Chrome permissions, and here's why each is needed:

- **`storage`** — to save your local leak counter and on/off preference on your device
- **`clipboardRead`** — to read the text you paste so we can check it for sensitive patterns before it reaches the AI tool. This data never leaves your browser.
- **`scripting`** — to inject the content script that watches for paste events on AI tool websites
- **`alarms`** — to schedule the daily rules update check
- **Host permissions** — limited to the specific AI tool websites (ChatGPT, Claude, Gemini, Perplexity, Copilot). The extension does NOT have access to other websites you visit.

## Source code is open
The full source code of AI Leak Guard is publicly available on GitHub. You can audit exactly what the extension does. If the code ever transmits user content, it will be visible there.

Repository: https://github.com/zabcore/ai-leak-guard

## Changes to this policy
If the privacy promise ever changes — for example, if we add an opt-in analytics feature in a future version — the change will be:
- Documented in the extension changelog
- Communicated in the Chrome Web Store listing update notes
- Made opt-in by default (you must explicitly enable it)
- Reflected in this document with a version date

We will never change the V1 promise (zero user text transmission) without an explicit, opt-in user action.

## Contact
For privacy questions or to report a concern, file an issue at:
https://github.com/zabcore/ai-leak-guard/issues

## Plain-English summary
You install a free Chrome extension. It watches when you paste things into ChatGPT, Claude, Gemini, Perplexity, or Microsoft Copilot. If it sees something risky (an API key, an SSN, a credit card), it replaces that part with a placeholder before the AI tool receives it. None of your text is sent anywhere. None of it is stored on any server. The extension counts how many times it's helped you, and that count lives only on your computer. That's it.
