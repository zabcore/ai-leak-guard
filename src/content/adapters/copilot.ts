import type { SiteAdapter } from './base'

export const copilotAdapter: SiteAdapter = {
  domain: ['copilot.microsoft.com'],
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
