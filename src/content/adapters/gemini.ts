import type { SiteAdapter } from './base'
import {
  insertText,
  replaceContents,
  isContentEditableElement,
  resolveBySelectors,
} from './fallback'

// The contenteditable inside the <rich-textarea> custom element.
const COMPOSER_SELECTORS = ['rich-textarea [contenteditable="true"]']

// Gemini wraps its contenteditable composer in a <rich-textarea> custom element.
function isPromptInput(el: Element): boolean {
  if (el.matches('rich-textarea [contenteditable="true"]')) return true
  return isContentEditableElement(el)
}

const gemini: SiteAdapter = {
  domains: ['gemini.google.com'],
  id: 'gemini',
  isPromptInput,
  resolveComposer: (root = document) => resolveBySelectors(root, COMPOSER_SELECTORS),
  insertText,
  replaceContents,
}

export default gemini
