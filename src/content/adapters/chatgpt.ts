import type { SiteAdapter } from './base'
import { insertText, replaceContents, isContentEditableElement } from './fallback'

// ChatGPT's composer is a contenteditable div (id="prompt-textarea",
// role="textbox"); older builds exposed data-id="root".
function isPromptInput(el: Element): boolean {
  if (el.matches('#prompt-textarea')) return true
  if (el.matches('[contenteditable="true"][role="textbox"]')) return true
  // Logged-out landing / pre-hydration fallback composer (the visible
  // "Ask ChatGPT" box) is a real <textarea name="prompt-textarea">, NOT
  // the ProseMirror div — without this, paste/send there is never scanned
  // (field-reported PHI leak on chatgpt.com/uc). `name` is a stable,
  // locale-independent hook; the CSS-module class is a hash, so avoid it.
  if (el.matches('textarea[name="prompt-textarea"]')) return true
  if (el.matches('[data-id="root"]') && isContentEditableElement(el)) return true
  return isContentEditableElement(el)
}

const chatgpt: SiteAdapter = {
  domains: ['chatgpt.com', 'chat.openai.com'],
  id: 'chatgpt',
  isPromptInput,
  insertText,
  replaceContents,
}

export default chatgpt
