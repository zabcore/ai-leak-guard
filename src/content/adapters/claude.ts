import type { SiteAdapter } from './base'

export const claudeAdapter: SiteAdapter = {
  domain: ['claude.ai'],
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
