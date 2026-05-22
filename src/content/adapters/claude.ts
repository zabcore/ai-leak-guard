import type { SiteAdapter } from './base'
import { insertText, replaceContents, isContentEditableElement } from './fallback'

// Claude uses a ProseMirror editor exposed as [contenteditable][role="textbox"].
function isPromptInput(el: Element): boolean {
  if (el.matches('[contenteditable="true"][role="textbox"]')) return true
  return isContentEditableElement(el)
}

const claude: SiteAdapter = {
  domains: ['claude.ai'],
  id: 'claude',
  isPromptInput,
  insertText,
  replaceContents,
}

export default claude
