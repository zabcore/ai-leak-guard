import type { SiteAdapter } from './base'
import {
  insertText,
  replaceContents,
  isContentEditableElement,
  resolveBySelectors,
} from './fallback'

// Gemini's composer is now a QUILL editor: the `.ql-editor` contenteditable
// inside the <rich-textarea> custom element. The bare
// `rich-textarea [contenteditable="true"]` now matches two nodes (`.ql-editor`
// AND Quill's hidden `.ql-clipboard`), so `.ql-editor` is the primary handle;
// the bare selector is kept only as a defensive fallback (tried second).
const COMPOSER_SELECTORS = [
  'rich-textarea .ql-editor[contenteditable="true"]',
  'rich-textarea [contenteditable="true"]',
]

// Gemini wraps its Quill contenteditable composer in a <rich-textarea> custom
// element. Match the `.ql-editor`, or any contenteditable inside the host that
// is not Quill's hidden `.ql-clipboard`.
function isPromptInput(el: Element): boolean {
  if (el.matches('rich-textarea .ql-editor[contenteditable="true"]')) return true
  if (
    el.closest('rich-textarea') !== null &&
    el.matches('[contenteditable="true"]') &&
    !el.matches('.ql-clipboard')
  ) {
    return true
  }
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
