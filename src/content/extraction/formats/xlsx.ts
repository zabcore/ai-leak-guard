// V1.2 M6 XLSX text extractor — Worker orchestration.
//
// SheetJS parses `.xlsx` into an in-memory workbook; `sheet_to_csv`
// turns each sheet into a CSV string that preserves rows and columns
// as `\n` and `,` — which is exactly the plain-text shape the A3
// detector wants. Multiple sheets are concatenated with a blank-line
// separator so a finding from sheet 2 doesn't merge into sheet 1.
//
// The actual parsing happens in `xlsx.worker.ts`, spawned per call
// and terminated on abort. This is the M6 fix for the release-
// blocking CVE issue #31: `XLSX.read` / `sheet_to_csv` are
// SYNCHRONOUS on the main thread and can't be preempted, so a hostile
// ReDoS workbook would peg the tab until the parser returned. Running
// them in a Worker means the extraction `AbortSignal` (from the 10 s
// timer in `extract.ts`) can call `worker.terminate()` and drop the
// entire parse context in one shot.
//
// SheetJS ships from the patched CDN build (>= 0.20.2, addressing
// CVE-2023-30533 and CVE-2024-22363). It's still bundled locally
// via the `?worker` import below; the extension makes zero network
// requests at runtime.

import type { FormatOutput } from '../extract'

export interface ExtractXlsxOptions {
  readonly signal?: AbortSignal
  /**
   * Test seam. Production omits this and gets the real Vite-bundled
   * `?worker` factory. Tests inject a synchronous fake so no real
   * `Worker` needs to be spawned in jsdom (which has no Worker).
   */
  readonly workerFactory?: WorkerFactory
}

/** Structural type for the worker we spawn. Matches the browser `Worker`. */
export interface XlsxWorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void
  terminate(): void
  onmessage: ((event: MessageEvent) => void) | null
  onerror: ((event: unknown) => void) | null
}

export type WorkerFactory = () => XlsxWorkerLike

interface WorkerResult {
  readonly kind: 'text' | 'reason'
  readonly text?: string
  readonly reason?: string
}

let cachedFactory: WorkerFactory | null = null
let overrideFactory: WorkerFactory | null = null

/**
 * Test seam — set a synchronous fake to avoid spawning a real
 * Worker in jsdom. Pass `null` to restore the production loader.
 */
export function __setXlsxWorkerFactoryForTesting(factory: WorkerFactory | null): void {
  overrideFactory = factory
  // Drop the memoised production factory so a follow-up production
  // call in the same test file (unlikely, but not impossible)
  // triggers a fresh dynamic import.
  if (factory !== null) cachedFactory = null
}

async function loadDefaultFactory(): Promise<WorkerFactory> {
  if (cachedFactory !== null) return cachedFactory
  const mod = await import('./xlsx.worker.ts?worker')
  const WorkerCtor = mod.default as unknown as new () => XlsxWorkerLike
  cachedFactory = (): XlsxWorkerLike => new WorkerCtor()
  return cachedFactory
}

export async function extractXlsx(
  file: File,
  opts: ExtractXlsxOptions = {},
): Promise<FormatOutput> {
  if (opts.signal?.aborted) return { kind: 'reason', reason: 'timeout' }

  const buf = await file.arrayBuffer()
  if (opts.signal?.aborted) return { kind: 'reason', reason: 'timeout' }

  const factory = opts.workerFactory ?? overrideFactory ?? (await loadDefaultFactory())
  if (opts.signal?.aborted) return { kind: 'reason', reason: 'timeout' }

  const worker = factory()

  return new Promise<FormatOutput>((resolve) => {
    let settled = false
    let onAbort: (() => void) | null = null

    const cleanup = (): void => {
      worker.onmessage = null
      worker.onerror = null
      if (onAbort && opts.signal) {
        opts.signal.removeEventListener('abort', onAbort)
      }
      // Always terminate — safe when the worker has already replied
      // (no-op) and load-bearing when the abort branch fires.
      try {
        worker.terminate()
      } catch {
        // Terminate must never throw upward.
      }
    }

    const settle = (out: FormatOutput): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(out)
    }

    worker.onmessage = (event: MessageEvent) => {
      const data = event.data as WorkerResult
      if (data && data.kind === 'text' && typeof data.text === 'string') {
        settle({ kind: 'text', text: data.text })
      } else if (data && data.kind === 'reason') {
        settle({ kind: 'reason', reason: data.reason as FormatOutput['reason'] })
      } else {
        settle({ kind: 'reason' })
      }
    }
    worker.onerror = () => {
      settle({ kind: 'reason' })
    }
    onAbort = (): void => {
      // Terminate the worker so a hostile parser stops burning CPU
      // immediately, then settle with the timeout reason so the
      // caller in `extract.ts` returns `unable_to_inspect / timeout`.
      settle({ kind: 'reason', reason: 'timeout' })
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })

    // Transfer the buffer for zero-copy handoff — the worker owns
    // the memory from here.
    worker.postMessage({ buf }, [buf])
  })
}
