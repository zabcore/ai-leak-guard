import type { SiteAdapter } from './base'
import { insertText, replaceContents, isContentEditableElement } from './fallback'

// Microsoft Copilot uses a <textarea> composer.
function isPromptInput(el: Element): boolean {
  if (el.matches('textarea')) return true
  return isContentEditableElement(el)
}

const copilot: SiteAdapter = {
  domains: ['copilot.microsoft.com'],
  id: 'copilot',
  isPromptInput,
  insertText,
  replaceContents,
}

export default copilot
