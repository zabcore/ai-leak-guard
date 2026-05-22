import type { SiteAdapter } from './base'

export const geminiAdapter: SiteAdapter = {
  domain: ['gemini.google.com'],
  isInputElement(_el) {
    return false
  },
  insertText(_el, _text) {
    return false
  },
  replaceContents(_el, _text) {
    return false
  },
}
