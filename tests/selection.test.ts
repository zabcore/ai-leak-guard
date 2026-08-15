// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { captureSelection, restoreSelection } from '../src/content/selection'

afterEach(() => {
  document.body.innerHTML = ''
  const sel = document.getSelection()
  sel?.removeAllRanges()
})

function selectRangeIn(node: Text, start: number, end: number): Range {
  const range = document.createRange()
  range.setStart(node, start)
  range.setEnd(node, end)
  const sel = document.getSelection()
  sel?.removeAllRanges()
  sel?.addRange(range)
  return range
}

describe('captureSelection', () => {
  it('returns null when there is no selection', () => {
    expect(captureSelection()).toBeNull()
  })

  it('returns a cloned Range for a document-level selection', () => {
    const editable = document.createElement('div')
    editable.setAttribute('contenteditable', 'true')
    editable.textContent = 'Hello world'
    document.body.appendChild(editable)
    const textNode = editable.firstChild as Text
    selectRangeIn(textNode, 6, 11) // "world"

    const captured = captureSelection()
    expect(captured).not.toBeNull()
    expect(captured?.toString()).toBe('world')
  })

  it('returns a CLONE — mutating the live selection afterwards does not change the snapshot', () => {
    const editable = document.createElement('div')
    editable.setAttribute('contenteditable', 'true')
    editable.textContent = 'Hello world'
    document.body.appendChild(editable)
    const textNode = editable.firstChild as Text
    selectRangeIn(textNode, 6, 11)

    const snapshot = captureSelection()
    document.getSelection()?.removeAllRanges()

    // The live selection has been cleared; the snapshot must still hold "world".
    expect(snapshot?.toString()).toBe('world')
  })
})

describe('restoreSelection', () => {
  it('no-ops when the range is null', () => {
    const editable = document.createElement('div')
    editable.setAttribute('contenteditable', 'true')
    document.body.appendChild(editable)
    // Should not throw and should not create any selection.
    restoreSelection(editable, null)
    expect(document.getSelection()?.rangeCount ?? 0).toBe(0)
  })

  it('re-applies the captured range as the document selection', () => {
    const editable = document.createElement('div')
    editable.setAttribute('contenteditable', 'true')
    editable.textContent = 'Hello world'
    document.body.appendChild(editable)
    const textNode = editable.firstChild as Text
    selectRangeIn(textNode, 6, 11) // "world"
    const snapshot = captureSelection()

    // Simulate the modal stealing focus and wiping the selection.
    document.getSelection()?.removeAllRanges()
    expect(document.getSelection()?.rangeCount ?? 0).toBe(0)

    restoreSelection(editable, snapshot)

    const sel = document.getSelection()
    expect(sel?.rangeCount).toBe(1)
    expect(sel?.getRangeAt(0).toString()).toBe('world')
  })

  it('focuses the target element so subsequent execCommand insertions land there', () => {
    const editable = document.createElement('div')
    editable.setAttribute('contenteditable', 'true')
    editable.textContent = 'abcdef'
    document.body.appendChild(editable)
    const textNode = editable.firstChild as Text
    selectRangeIn(textNode, 0, 3)
    const snapshot = captureSelection()

    // Move focus elsewhere.
    const other = document.createElement('input')
    document.body.appendChild(other)
    other.focus()
    expect(document.activeElement).toBe(other)

    restoreSelection(editable, snapshot)
    expect(document.activeElement).toBe(editable)
  })
})
