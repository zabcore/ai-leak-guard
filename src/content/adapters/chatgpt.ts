import type { SiteAdapter } from './base'
import {
  insertText,
  replaceContents,
  isContentEditableElement,
  resolveBySelectors,
} from './fallback'

// Stable/primary composer selectors — the ProseMirror div, the logged-out
// composers, and the generic role=textbox editor.
const COMPOSER_SELECTORS = [
  '#prompt-textarea',
  // V1.3.3: logged-out chatgpt.com renders the composer as a plain <textarea
  // id="mobile-composer-prompt" name="prompt"> inside a <form> — no
  // contenteditable at all. Confirmed live 17 Sep 2026.
  'textarea#mobile-composer-prompt',
  'textarea[name="prompt-textarea"]',
  'textarea[data-testid="prompt-textarea"]',
  '[contenteditable="true"][role="textbox"]',
]

/** The current logged-out form composer: <textarea name="prompt"> with an
 *  "Ask…" placeholder. Defensive (id-independent) match for chatgpt hosts. */
function isLoggedOutFormComposer(el: Element): boolean {
  if (!el.matches('textarea[name="prompt"]')) return false
  const placeholder = el.getAttribute('placeholder') ?? ''
  return /ask/i.test(placeholder)
}

// ChatGPT's logged-in composer is a contenteditable div (id="prompt-textarea",
// role="textbox"); older builds exposed data-id="root". Logged-out builds use a
// plain <textarea>.
function isPromptInput(el: Element): boolean {
  if (el.matches('#prompt-textarea')) return true
  if (el.matches('[contenteditable="true"][role="textbox"]')) return true
  // Logged-out landing / pre-hydration fallback composer (the visible
  // "Ask ChatGPT" box) is a real <textarea name="prompt-textarea">, NOT
  // the ProseMirror div — without this, paste/send there is never scanned
  // (field-reported PHI leak on chatgpt.com/uc). `name` is a stable,
  // locale-independent hook; the CSS-module class is a hash, so avoid it.
  if (el.matches('textarea[name="prompt-textarea"]')) return true
  // V1.3.3: the current logged-out form composer (RELEASE BLOCKER — the
  // composer renamed to <textarea id="mobile-composer-prompt" name="prompt">).
  if (el.matches('textarea#mobile-composer-prompt')) return true
  if (isLoggedOutFormComposer(el)) return true
  if (el.matches('[data-id="root"]') && isContentEditableElement(el)) return true
  return isContentEditableElement(el)
}

const chatgpt: SiteAdapter = {
  domains: ['chatgpt.com', 'chat.openai.com'],
  id: 'chatgpt',
  isPromptInput,
  resolveComposer: (root = document) => resolveBySelectors(root, COMPOSER_SELECTORS),
  insertText,
  replaceContents,
}

export default chatgpt
