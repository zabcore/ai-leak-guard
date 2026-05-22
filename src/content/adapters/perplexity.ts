import type { SiteAdapter } from './base'

export const perplexityAdapter: SiteAdapter = {
  domain: ['www.perplexity.ai'],
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
