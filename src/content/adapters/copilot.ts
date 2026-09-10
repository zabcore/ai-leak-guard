import type { SiteAdapter } from './base'
import { insertText, replaceContents, isContentEditableElement } from './fallback'

// V1.3.1: Copilot migrated. `copilot.microsoft.com` now redirects both
// personal and work accounts to `copilot.cloud.microsoft/chat`, whose
// composer is a Lexical `contenteditable="true"` `role="textbox"` span
// (`#m365-chat-editor-target-element`, `data-lexical-editor="true"`),
// NOT the old `<textarea>`. Match the contenteditable shape first and
// keep the textarea fallback for the legacy surface. Insert/replace use
// the contenteditable-aware fallback path (same as claude/gemini).
function isPromptInput(el: Element): boolean {
  if (el.matches('[contenteditable="true"][role="textbox"]')) return true
  if (el.matches('textarea')) return true
  return isContentEditableElement(el)
}

const copilot: SiteAdapter = {
  // Both hosts listed — `getAdapterForHost` matches the exact hostname,
  // and the legacy origin still exists as a (harmless) redirector.
  domains: ['copilot.cloud.microsoft', 'copilot.microsoft.com'],
  id: 'copilot',
  isPromptInput,
  insertText,
  replaceContents,
}

export default copilot
