import type { SiteAdapter } from './base'
import { insertText, replaceContents, isContentEditableElement, isTextField } from './fallback'

// Perplexity's main composer is a <textarea> with an "Ask..." placeholder.
function isPromptInput(el: Element): boolean {
  if (el.matches('textarea[placeholder*="Ask"]')) return true
  return isTextField(el) || isContentEditableElement(el)
}

const perplexity: SiteAdapter = {
  domains: ['www.perplexity.ai', 'perplexity.ai'],
  id: 'perplexity',
  isPromptInput,
  insertText,
  replaceContents,
}

export default perplexity
