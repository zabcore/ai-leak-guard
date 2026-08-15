// Selection save/restore helpers for the preview-before-send paste flow.
//
// The problem: when a user has text selected inside a contenteditable editor
// (ChatGPT / Claude / Gemini / Copilot use ProseMirror or Lexical) and
// pastes, our preview modal opens and steals focus onto its primary button.
// The moment focus leaves the editor, `document.getSelection()` collapses
// away from the editor's Range — so a later `execCommand('insertText', …)`
// no longer has anything to replace and appends at the caret instead.
//
// Fix: on paste, snapshot the current Range. Before we insert (protected
// OR as-is), restore that Range as the document selection so `insertText`
// replaces it exactly as if focus never left.
//
// Only contenteditable editors are affected. `<textarea>` and `<input>`
// track `selectionStart` / `selectionEnd` on the element itself; those
// values persist through focus loss, and the fallback adapter's slice-based
// insertText already reads them at insertion time. `captureSelection()`
// returns null for those cases and `restoreSelection()` no-ops.

/**
 * Snapshots the current `document.getSelection()` Range so it can be
 * re-applied later. Returns `null` when there is no selection or when
 * the selection is not part of the DOM (textareas / inputs report no
 * Range here, which is what we want — see file header).
 */
export function captureSelection(): Range | null {
  const sel = typeof globalThis.getSelection === 'function' ? globalThis.getSelection() : null
  if (sel === null || sel.rangeCount === 0) return null
  try {
    return sel.getRangeAt(0).cloneRange()
  } catch {
    return null
  }
}

/**
 * Re-applies a captured Range as the current document selection so a
 * subsequent `execCommand('insertText', …)` replaces the selection
 * instead of inserting at the caret. Guarded against detached Ranges
 * and DOM environments (test harnesses) that omit `getSelection`.
 *
 * `focus()` is called on the target first so the browser routes editing
 * commands there — the modal's close routine already does this, but
 * repeating it here makes the helper safe to call in isolation and
 * matches the fallback adapter's own defensive `.focus()`.
 */
export function restoreSelection(target: Element, range: Range | null): void {
  if (range === null) return
  ;(target as HTMLElement).focus?.()
  const sel = typeof globalThis.getSelection === 'function' ? globalThis.getSelection() : null
  if (sel === null) return
  try {
    sel.removeAllRanges()
    sel.addRange(range)
  } catch {
    // Range was detached (DOM changed while the modal was open) or the
    // browser rejected it. Leave selection wherever `focus()` resolved and
    // continue — insertion will still land at the caret rather than
    // throwing.
  }
}
