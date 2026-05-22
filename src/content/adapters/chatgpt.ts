import type { SiteAdapter } from './base'

export const chatgptAdapter: SiteAdapter = {
  domain: ['chatgpt.com', 'chat.openai.com'],
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
