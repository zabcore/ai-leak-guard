// Pure helpers that pull a `File[]` off the three DOM events the V1.2
// document-protection flow intercepts:
//   - `change` on `<input type="file">`  → `input.files`
//   - `drop` on the composer / window   → `dataTransfer.files`
//   - `paste` with attached files       → `clipboardData.files`
//
// Kept separate from `document-flow.ts` so the extraction is
// unit-testable with fabricated events. No DOM mutation, no side
// effects, no reading of file bytes — the returned array is a
// reference list, not a copy. Callers hold these references only until
// the user resolves the modal, then either release them (Upload
// anyway) or drop them (Cancel).

export type FileEventKind = 'change' | 'drop' | 'paste'

export interface ExtractedFiles {
  readonly kind: FileEventKind
  readonly files: readonly File[]
  /**
   * The `<input type="file">` that fired the change event, if the
   * event was a change AND we could resolve one. Populated only for
   * `change`. Used by the release path to (a) reset `input.value` on
   * cancel and (b) attempt the DataTransfer re-dispatch on upload-anyway.
   */
  readonly originInput: HTMLInputElement | null
}

function toFileArray(list: FileList | null | undefined): File[] {
  if (!list || list.length === 0) return []
  const files: File[] = []
  for (let i = 0; i < list.length; i += 1) {
    const f = list.item(i)
    if (f !== null) files.push(f)
  }
  return files
}

export function extractFilesFromChange(event: Event): ExtractedFiles | null {
  const target = event.target
  if (!(target instanceof HTMLInputElement)) return null
  if (target.type !== 'file') return null
  const files = toFileArray(target.files)
  if (files.length === 0) return null
  return { kind: 'change', files, originInput: target }
}

export function extractFilesFromDrop(event: DragEvent): ExtractedFiles | null {
  const files = toFileArray(event.dataTransfer?.files ?? null)
  if (files.length === 0) return null
  return { kind: 'drop', files, originInput: null }
}

export function extractFilesFromPaste(event: ClipboardEvent): ExtractedFiles | null {
  const files = toFileArray(event.clipboardData?.files ?? null)
  if (files.length === 0) return null
  return { kind: 'paste', files, originInput: null }
}
