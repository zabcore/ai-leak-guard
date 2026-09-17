import type { SiteAdapter } from './base'
import {
  insertText,
  replaceContents,
  isContentEditableElement,
  resolveBySelectors,
} from './fallback'

// ProseMirror editor + the pre-hydration static composer (v1.3.2).
const COMPOSER_SELECTORS = [
  '[contenteditable="true"][role="textbox"]',
  'textarea#static-composer-input',
]

// Claude uses a ProseMirror editor exposed as [contenteditable][role="textbox"].
function isPromptInput(el: Element): boolean {
  if (el.matches('[contenteditable="true"][role="textbox"]')) return true
  // Pre-hydration static composer (the "How can I help you today?" box) is a
  // real <textarea id="static-composer-input">, shown before the TipTap
  // editor hydrates — without this it is never scanned (same class of gap
  // as ChatGPT's fallback textarea). Stable id hook.
  if (el.matches('textarea#static-composer-input')) return true
  return isContentEditableElement(el)
}

const claude: SiteAdapter = {
  domains: ['claude.ai'],
  id: 'claude',
  isPromptInput,
  resolveComposer: (root = document) => resolveBySelectors(root, COMPOSER_SELECTORS),
  insertText,
  replaceContents,
}

export default claude
