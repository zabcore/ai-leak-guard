export interface SiteAdapter {
  domain: string[]
  isInputElement(el: Element): boolean
  insertText(el: Element, text: string): boolean
  replaceContents(el: Element, text: string): boolean
}
