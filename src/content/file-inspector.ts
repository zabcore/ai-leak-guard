// V1.2 A1 file-inspector STUB.
//
// A1 ships the interception plumbing (hold + upload-anyway/cancel) but
// **no content inspection**. The real inspector — PDF text extraction,
// DOCX unwrap, image OCR, detector-engine integration — lands in A2/A3.
// This stub returns "no findings" for every input so the flow can
// exercise the whole hold → confirm → release chain end-to-end without
// any parser, network, or detector dependency.
//
// The stub is deliberately extremely narrow: the input is `File[]`, the
// output is a shape the future real inspector must be a drop-in
// replacement for. Only file metadata (`name`, `size`, `type`) is
// carried through — the file contents are NEVER read in A1. This
// matches the brief's "treat files defensively — hold references only,
// don't read contents in A1".

import type { Finding } from '../detector/types'

export interface FileMeta {
  /** The original File object — reference only, not a byte copy. */
  readonly file: File
  /** File name as reported by the browser. Not surfaced in A1 UI. */
  readonly name: string
  /** Size in bytes. Not surfaced in A1 UI. */
  readonly size: number
  /** MIME type as reported by the browser. */
  readonly type: string
}

export interface FileInspection {
  readonly files: readonly FileMeta[]
  /**
   * Findings that would be masked / redacted if this were the real
   * inspector. A1 stub always returns `[]`; the placeholder modal
   * consumes this as "N file(s) will be uploaded; content inspection
   * not yet available".
   */
  readonly findings: readonly Finding[]
}

/**
 * A1 stub. Returns metadata and an empty findings list without reading
 * any file bytes. Callers must not assume `findings` will remain empty
 * in later releases — the shape is the API contract, not the emptiness.
 */
export function inspectFiles(files: readonly File[]): FileInspection {
  return {
    files: files.map((file) => ({
      file,
      name: file.name,
      size: file.size,
      type: file.type,
    })),
    findings: [],
  }
}
