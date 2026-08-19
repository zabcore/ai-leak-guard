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

import * as XLSX from 'xlsx'
import type { FormatOutput } from '../extract'

export async function extractXlsx(file: File): Promise<FormatOutput> {
  const buf = await file.arrayBuffer()
  const wb = XLSX.read(buf, { type: 'array' })
  if (!wb.SheetNames || wb.SheetNames.length === 0) {
    return { kind: 'reason' }
  }
  const parts: string[] = []
  for (const name of wb.SheetNames) {
    const sheet = wb.Sheets[name]
    if (!sheet) continue
    parts.push(XLSX.utils.sheet_to_csv(sheet))
  }
  return { kind: 'text', text: parts.join('\n\n') }
}
