// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  extractFilesFromChange,
  extractFilesFromDrop,
  extractFilesFromPaste,
} from '../src/content/file-extraction'

function fileList(...files: File[]): FileList {
  const dt = new DataTransfer()
  for (const f of files) dt.items.add(f)
  return dt.files
}

describe('extractFilesFromChange', () => {
  it('returns null when target is not a file input', () => {
    const textInput = document.createElement('input')
    textInput.type = 'text'
    const ev = new Event('change')
    Object.defineProperty(ev, 'target', { value: textInput, configurable: true })
    expect(extractFilesFromChange(ev)).toBeNull()
  })

  it('returns null when target is a file input with no files', () => {
    const input = document.createElement('input')
    input.type = 'file'
    const ev = new Event('change')
    Object.defineProperty(ev, 'target', { value: input, configurable: true })
    expect(extractFilesFromChange(ev)).toBeNull()
  })

  it('returns the FileList and origin input when a single file is selected', () => {
    const input = document.createElement('input')
    input.type = 'file'
    const file = new File(['x'], 'a.pdf', { type: 'application/pdf' })
    input.files = fileList(file)
    const ev = new Event('change')
    Object.defineProperty(ev, 'target', { value: input, configurable: true })

    const out = extractFilesFromChange(ev)
    expect(out).not.toBeNull()
    expect(out?.kind).toBe('change')
    expect(out?.originInput).toBe(input)
    expect(out?.files.length).toBe(1)
    expect(out?.files[0]).toBe(file)
  })

  it('returns all files when multiple are selected', () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    const a = new File(['x'], 'a.pdf', { type: 'application/pdf' })
    const b = new File(['y'], 'b.png', { type: 'image/png' })
    input.files = fileList(a, b)
    const ev = new Event('change')
    Object.defineProperty(ev, 'target', { value: input, configurable: true })

    const out = extractFilesFromChange(ev)
    expect(out?.files.length).toBe(2)
    expect(out?.files[0]).toBe(a)
    expect(out?.files[1]).toBe(b)
  })
})

describe('extractFilesFromDrop', () => {
  it('returns null when the drop has no dataTransfer files', () => {
    const ev = new DragEvent('drop')
    expect(extractFilesFromDrop(ev)).toBeNull()
  })

  it('returns the files from dataTransfer.files when present', () => {
    const file = new File(['x'], 'doc.pdf', { type: 'application/pdf' })
    const dt = new DataTransfer()
    dt.items.add(file)
    const ev = new DragEvent('drop', { dataTransfer: dt })
    const out = extractFilesFromDrop(ev)
    expect(out).not.toBeNull()
    expect(out?.kind).toBe('drop')
    expect(out?.originInput).toBeNull()
    expect(out?.files.length).toBe(1)
    expect(out?.files[0]).toBe(file)
  })
})

describe('extractFilesFromPaste', () => {
  it('returns null when the paste has no clipboardData files', () => {
    const ev = new ClipboardEvent('paste', { clipboardData: new DataTransfer() })
    expect(extractFilesFromPaste(ev)).toBeNull()
  })

  it('returns the files from clipboardData.files when present (pasted image path)', () => {
    const file = new File(['x'], 'pasted.png', { type: 'image/png' })
    const dt = new DataTransfer()
    dt.items.add(file)
    const ev = new ClipboardEvent('paste', { clipboardData: dt })
    const out = extractFilesFromPaste(ev)
    expect(out).not.toBeNull()
    expect(out?.kind).toBe('paste')
    expect(out?.originInput).toBeNull()
    expect(out?.files[0]).toBe(file)
  })
})
