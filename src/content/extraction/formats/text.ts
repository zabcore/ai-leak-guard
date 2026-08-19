// V1.2 A2 plain text extractor. Handles `.txt`, `.md`, `.csv` (and
// any file the sniffer classified as `text`). Uses the browser's
// native `File.text()`, which decodes UTF-8 (with BOM handling) and
// returns a string — no third-party parser, no dependencies. This
// module is lazy-loaded from `extract.ts` so a paste-only session
// pays for nothing here beyond the module itself.

import type { FormatOutput } from '../extract'

export async function extractPlainText(file: File): Promise<FormatOutput> {
  const text = await file.text()
  return { kind: 'text', text }
}
