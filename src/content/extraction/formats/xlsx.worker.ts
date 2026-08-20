// V1.2 M6 XLSX-parse Worker.
//
// SheetJS's `XLSX.read` and `sheet_to_csv` are SYNCHRONOUS and can
// take unbounded time on a hostile workbook (ReDoS payload,
// pathological cell reference chains). Running them on the main
// thread means the extraction timeout in `extract.ts` cannot preempt
// them — the tab is pegged until the parser returns. Moving the
// parse into a dedicated Worker lets the caller `worker.terminate()`
// as soon as its `AbortSignal` fires, dropping the whole parse
// context (call stack, ArrayBuffer, workbook state) in one shot.
//
// Wire contract with `xlsx.ts`:
//
//   main → worker  { buf: ArrayBuffer }          (transferred, zero-copy)
//   main ← worker  { kind: 'text', text: string }
//   main ← worker  { kind: 'reason', reason?: 'parse-error' | 'empty' | ... }
//
// The worker imports SheetJS at module load. SheetJS ships bundled
// (patched CDN build — see `docs/ARCHITECTURE.md`); the worker
// bundle is emitted by Vite via the `?worker` import in `xlsx.ts`.
//
// Nothing here reads the filesystem, network, or DOM. SheetJS never
// executes VBA macros (it ignores the `vbaProject` stream) — that is
// what keeps this safe against a hostile workbook.

import * as XLSX from 'xlsx'

interface InboundMessage {
  readonly buf: ArrayBuffer
}
type OutboundMessage =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'reason'; readonly reason?: string }

// Worker global has a different `self` typing; cast narrowly.
const workerSelf = self as unknown as {
  onmessage: ((event: MessageEvent<InboundMessage>) => void) | null
  postMessage(message: OutboundMessage): void
}

workerSelf.onmessage = (event) => {
  const { buf } = event.data
  try {
    const wb = XLSX.read(buf, { type: 'array' })
    if (!wb.SheetNames || wb.SheetNames.length === 0) {
      workerSelf.postMessage({ kind: 'reason' })
      return
    }
    const parts: string[] = []
    for (const name of wb.SheetNames) {
      const sheet = wb.Sheets[name]
      if (!sheet) continue
      parts.push(XLSX.utils.sheet_to_csv(sheet))
    }
    workerSelf.postMessage({ kind: 'text', text: parts.join('\n\n') })
  } catch (err) {
    // Any parser throw becomes `parse-error` upstream (default
    // `kind: 'reason'` with no explicit reason maps to parse-error
    // in `extract.ts` → `finalize`).
    void err
    workerSelf.postMessage({ kind: 'reason' })
  }
}
