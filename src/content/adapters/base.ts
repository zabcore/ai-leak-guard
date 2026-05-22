// Pure types only. No DOM helpers and no Chrome API access in this file.

export interface SiteAdapter {
  /** Lowercase hostnames this adapter handles, e.g. ['chatgpt.com', 'chat.openai.com'] */
  readonly domains: readonly string[]

  /** Stable identifier for logging, e.g. 'chatgpt', 'claude' */
  readonly id: string

  /**
   * Returns true if the given element is the prompt input that should be
   * monitored on this site. Used to decide whether to intercept a paste.
   */
  isPromptInput(el: Element): boolean

  /**
   * Insert `text` at the current cursor position inside `el`, replacing any
   * current selection. Should fire input/change events so the site's framework
   * state updates correctly.
   * Returns true on success, false if insertion failed (the caller may then
   * fall back to allowing the original paste).
   */
  insertText(el: Element, text: string): boolean

  /**
   * Replace the full contents of `el` with `text`. Used for the Undo flow to
   * restore the original pasted text.
   * Returns true on success, false otherwise.
   */
  replaceContents(el: Element, text: string): boolean
}
