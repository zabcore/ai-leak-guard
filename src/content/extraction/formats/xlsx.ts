// V1.2 A2 XLSX text extractor.
//
// SheetJS parses `.xlsx` into an in-memory workbook; `sheet_to_csv`
// turns each sheet into a CSV string that preserves rows and columns
// as `\n` and `,` — which is exactly the plain-text shape the A3
// detector wants. Multiple sheets are concatenated with a blank-line
// separator so a finding from sheet 2 doesn't merge into sheet 1.
//
// SheetJS never executes macros / VBA (it ignores the `vbaProject`
// stream), which is the property that makes it safe against a
// hostile workbook.
//
// Cancellation limits (documented in `docs/ARCHITECTURE.md`):
// `XLSX.read` and `sheet_to_csv` are SYNCHRONOUS. JavaScript cannot
// preempt synchronous work, so once parsing has begun the 10 s
// timeout in `extract.ts` cannot abort it — the tab is pegged until
// the parser returns. We mitigate by:
//   1. `MAX_EXTRACTION_BYTES` (20 MB) before we even reach here.
//   2. Signal pre-check + between-sheet check below: any abort that
//      arrives BEFORE `XLSX.read` starts, or between sheets, short-
//      circuits so we do not begin (or continue) expensive work.
// A fully-preemptible fix would move the parser into a dedicated
// Worker (terminable on abort). That refactor is deferred to the
// same PR that swaps `xlsx` for the patched SheetJS CDN build
// (owner action — see the PR discussion for the CVE-2023-30533 /
// CVE-2024-22363 remediation), because both changes touch the same
// dependency wiring.

import * as XLSX from 'xlsx'
import type { FormatOutput } from '../extract'

export interface ExtractXlsxOptions {
  readonly signal?: AbortSignal
}

export async function extractXlsx(
  file: File,
  opts: ExtractXlsxOptions = {},
): Promise<FormatOutput> {
  if (opts.signal?.aborted) return { kind: 'reason', reason: 'timeout' }
  const buf = await file.arrayBuffer()
  if (opts.signal?.aborted) return { kind: 'reason', reason: 'timeout' }
  const wb = XLSX.read(buf, { type: 'array' })
  if (!wb.SheetNames || wb.SheetNames.length === 0) {
    return { kind: 'reason' }
  }
  const parts: string[] = []
  for (const name of wb.SheetNames) {
    // Check between sheets so a multi-sheet workbook can be aborted
    // even if the individual `XLSX.read` at the top has already
    // completed. Best we can do without a Worker.
    if (opts.signal?.aborted) return { kind: 'reason', reason: 'timeout' }
    const sheet = wb.Sheets[name]
    if (!sheet) continue
    parts.push(XLSX.utils.sheet_to_csv(sheet))
  }
  return { kind: 'text', text: parts.join('\n\n') }
}
