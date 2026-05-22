import type { SiteAdapter } from './base'
import { insertText, replaceContents, isContentEditableElement } from './fallback'

// Gemini wraps its contenteditable composer in a <rich-textarea> custom element.
function isPromptInput(el: Element): boolean {
  if (el.matches('rich-textarea [contenteditable="true"]')) return true
  return isContentEditableElement(el)
}

const gemini: SiteAdapter = {
  domains: ['gemini.google.com'],
  id: 'gemini',
  isPromptInput,
  insertText,
  replaceContents,
}

export default gemini
