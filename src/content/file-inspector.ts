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

/**
 * Per-file inspection result. Findings are associated with the source
 * `FileMeta` so a multi-file inspection cannot produce
 * "which file produced this finding?" ambiguity when the real
 * inspector lands in A2. A1 always returns `findings: []` for each
 * entry.
 */
export interface FileInspectionEntry {
  readonly meta: FileMeta
  readonly findings: readonly Finding[]
}

export interface FileInspection {
  readonly perFile: readonly FileInspectionEntry[]
}

/**
 * Convenience aggregate — the flat list of findings across every file
 * in the inspection. A2 UI code that just wants a count uses this;
 * code that needs to attribute a finding to its source file walks
 * `perFile` instead.
 */
export function aggregateFindings(inspection: FileInspection): readonly Finding[] {
  const out: Finding[] = []
  for (const entry of inspection.perFile) out.push(...entry.findings)
  return out
}

/**
 * A1 stub. Returns metadata and an empty findings list for each file
 * without reading any file bytes. Callers must not assume the per-file
 * findings arrays will remain empty in later releases — the shape is
 * the API contract, not the emptiness.
 */
export function inspectFiles(files: readonly File[]): FileInspection {
  return {
    perFile: files.map((file) => ({
      meta: { file, name: file.name, size: file.size, type: file.type },
      findings: [],
    })),
  }
}
