// V1.2 A2 file inspector.
//
// A1 shipped a stub that returned "no findings" for every file
// without reading a byte. A2 replaces that stub with a real
// extraction pass — the file's bytes are read locally, converted to
// plain text, and attached to the entry. **Detection remains
// stubbed** (`findings: []`) — plugging `detect()` over the extracted
// text is A3's job.
//
// This is the single seam every document-flow path funnels through:
// the FSA picker (`fsa-isolated.ts`) and the change / drop / paste
// paths (`content/index.ts` → `document-flow.ts`) both call
// `inspectFiles`. Adding extraction here means both paths get it for
// free with no additional plumbing in the orchestrators.
//
// Contract (unchanged from A1):
//   • Inputs: an array of `File` references. Callers must hold the
//     originals unchanged for the release path — the inspector NEVER
//     mutates or replaces files.
//   • Never throws. Extraction failures are recorded on the entry
//     (via `extraction.status === 'unable_to_inspect'`); the flow
//     continues so the user is not blocked by a broken file.
//   • Extracted text lives ONLY on the returned entry (in memory).
//     A5 event logging must stay metadata-only.

import type { Finding } from '../detector/types'
import { extractText, type ExtractionResult } from './extraction/extract'

export interface FileMeta {
  /** The original File object — reference only, not a byte copy. */
  readonly file: File
  /** File name as reported by the browser. Not surfaced in A2 UI. */
  readonly name: string
  /** Size in bytes. Not surfaced in A2 UI. */
  readonly size: number
  /** MIME type as reported by the browser. */
  readonly type: string
}

/**
 * Per-file inspection result. `extraction` holds the plaintext (and
 * the honest `unable_to_inspect` fallback); `findings` stays empty
 * until A3 plugs in the detector.
 */
export interface FileInspectionEntry {
  readonly meta: FileMeta
  readonly extraction: ExtractionResult
  readonly findings: readonly Finding[]
}

export interface FileInspection {
  readonly perFile: readonly FileInspectionEntry[]
}

/**
 * Convenience aggregate — the flat list of findings across every
 * file. A2 always returns `[]` from here (detection is stubbed);
 * kept in place so A3's caller changes are additive.
 */
export function aggregateFindings(inspection: FileInspection): readonly Finding[] {
  const out: Finding[] = []
  for (const entry of inspection.perFile) out.push(...entry.findings)
  return out
}

/**
 * Run the extraction pass on every file concurrently and return a
 * `FileInspection`. Concurrent by design — pdf.js work is CPU-bound
 * and per-file, so extracting an N-file drop in parallel keeps
 * hold latency proportional to the slowest single file, not to the
 * sum.
 *
 * Never rejects. Any per-file extractor failure is captured on the
 * entry as `extraction.status === 'unable_to_inspect'`; the surrounding
 * flow always sees a resolved promise so a hostile file cannot deny
 * the user the hold modal.
 */
export async function inspectFiles(files: readonly File[]): Promise<FileInspection> {
  const perFile = await Promise.all(
    files.map(async (file): Promise<FileInspectionEntry> => {
      const extraction = await extractText(file)
      return {
        meta: { file, name: file.name, size: file.size, type: file.type },
        extraction,
        findings: [],
      }
    }),
  )
  return { perFile }
}
