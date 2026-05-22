import type { SiteAdapter } from './base'

type TextField = HTMLTextAreaElement | HTMLInputElement

export function isTextField(el: Element): el is TextField {
  return el.tagName === 'TEXTAREA' || el.tagName === 'INPUT'
}

// Checks the live `isContentEditable` property and falls back to the attribute,
// which keeps detection working in environments (e.g. jsdom) that do not
// compute `isContentEditable`.
export function isContentEditableElement(el: Element): boolean {
  if ((el as HTMLElement).isContentEditable) return true
  const attr = el.getAttribute('contenteditable')
  return attr === '' || attr === 'true'
}

export function genericIsPromptInput(el: Element): boolean {
  return isTextField(el) || isContentEditableElement(el)
}

export function insertText(el: Element, text: string): boolean {
  if (isTextField(el)) {
    const field = el
    const start = field.selectionStart ?? field.value.length
    const end = field.selectionEnd ?? field.value.length
    field.value = field.value.slice(0, start) + text + field.value.slice(end)
    const caret = start + text.length
    try {
      field.selectionStart = caret
      field.selectionEnd = caret
    } catch {
      // Some input types disallow selection range manipulation; ignore.
    }
    field.dispatchEvent(new Event('input', { bubbles: true }))
    field.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  }

  if (isContentEditableElement(el)) {
    ;(el as HTMLElement).focus()
    // execCommand is deprecated, but it remains the only reliable way to make
    // framework-managed contenteditable editors (React / ProseMirror / Lexical)
    // observe the change and update their internal state.
    return document.execCommand('insertText', false, text)
  }

  return false
}

export function replaceContents(el: Element, text: string): boolean {
  if (isTextField(el)) {
    const field = el
    field.value = text
    field.dispatchEvent(new Event('input', { bubbles: true }))
    field.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  }

  if (isContentEditableElement(el)) {
    ;(el as HTMLElement).focus()
    document.execCommand('selectAll')
    return document.execCommand('insertText', false, text)
  }

  return false
}

const fallbackAdapter: SiteAdapter = {
  domains: [],
  id: 'fallback',
  isPromptInput: genericIsPromptInput,
  insertText,
  replaceContents,
}

export default fallbackAdapter
