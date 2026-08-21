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

- The local counter of sensitive items masked (e.g., "47 sensitive items masked")
- Your on/off toggle preference
- A local activity log — up to 200 recent decisions — that records **metadata only**:
  - When the decision happened (timestamp)
  - Which site (e.g., `chatgpt`, `claude`)
  - Whether it was a paste or a document upload
  - What you chose (protected, pasted-as-is, uploaded anyway, auto-cleared, cancelled, or "couldn't inspect")
  - How many sensitive items were detected, and which broad categories (e.g., "SSN / financial", "credentials")
  - Whether any of them were high-severity

  The activity log **never** stores the matched values, the pasted text, file contents, or filenames. It exists so the popup can honestly show your recent activity ("Claude · document · 3 items · uploaded anyway · 2m ago") without ever holding the underlying content. The log is a bounded ring buffer — the oldest entry is dropped when a new one arrives past the cap.

This data is accessible only to the extension itself, on your device. Uninstalling the extension removes it.

### Full activity page + local export
The popup has a "View all activity →" link that opens a full **Activity** page (the extension's options page). It shows the same metadata-only records — timestamp, site, paste/document, action, category chips, count — with room to scroll through the full 200-event history.

The activity page also has **Export** buttons for CSV and JSON. Both exports are built entirely in your browser:

- The file is assembled in-page as a `Blob`, handed to a temporary anchor with a `download` attribute, and clicked programmatically. Nothing about this touches the network.
- Only the local metadata fields are exported — the same seven: `ts` (as an ISO timestamp), `site`, `eventType`, `action`, `categories`, `count`, `hadCriticalOrHigh`. No matched values, no pasted text, no file contents, no filenames appear in the export.
- The extension does **not** request Chrome's `downloads` permission; the anchor-click mechanism needs no permission.
- The exported file lands wherever your browser saves downloads. It is a local file on your device — the extension does not upload it, and there is no cloud sync in the free version.

If a future paid tier adds cross-device sync or team dashboards, that will be an explicit opt-in with a separate, prominent notice — the free extension will never start uploading your activity silently.

## Outbound network requests

AI Leak Guard makes **no outbound network requests**. Detection patterns are bundled with the extension and updated only through Chrome's normal extension-update mechanism (from the Chrome Web Store). There is no analytics endpoint, no telemetry server, no error reporting service, no third-party SDK that phones home.

## No accounts, no registration

AI Leak Guard does not require an account, email address, or any registration to use. There is nothing to sign up for.

## No third parties

The extension does not load code, scripts, fonts, or assets from any third-party service at runtime. It does not include analytics SDKs (no Google Analytics, no Mixpanel, no PostHog, no Sentry). It does not embed third-party widgets.

## Permissions explained

The extension requests the following Chrome permissions, and here's why each is needed:

- **`storage`** — to save your local counter of items masked, your on/off preference, and the local metadata-only activity log on your device
- **Host permissions** — limited to the specific AI tool websites (ChatGPT, Claude, Gemini, Perplexity, Copilot). The extension does NOT have access to other websites you visit. The pasted text is read from the paste event's own clipboard data on those sites, which is why no separate `clipboardRead` permission is requested.

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
