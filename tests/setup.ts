import { beforeEach } from 'vitest'

// In-memory stub of chrome.storage.local for tests. Installed on globalThis so
// the storage/counter modules can run without a real extension environment.
const store = new Map<string, unknown>()

const local = {
  get: async (keys?: string | string[] | null): Promise<Record<string, unknown>> => {
    if (keys === undefined || keys === null) {
      return Object.fromEntries(store)
    }
    const keyList = Array.isArray(keys) ? keys : [keys]
    const result: Record<string, unknown> = {}
    for (const key of keyList) {
      if (store.has(key)) result[key] = store.get(key)
    }
    return result
  },
  set: async (items: Record<string, unknown>): Promise<void> => {
    for (const [key, value] of Object.entries(items)) {
      store.set(key, value)
    }
  },
  clear: async (): Promise<void> => {
    store.clear()
  },
}

;(globalThis as unknown as { chrome: { storage: { local: typeof local } } }).chrome = {
  storage: { local },
}

beforeEach(() => {
  store.clear()
})

// ─── V1.2 A1 test polyfills ────────────────────────────────────────────────
//
// jsdom 29 does not implement DataTransfer, DragEvent, or ClipboardEvent.
// The V1.2 document-protection code (extraction, release, wiring) needs
// all three to be constructible in tests. These polyfills are just enough
// to (a) hold a `files` FileList-like list, (b) construct events that
// carry a `dataTransfer` / `clipboardData` field, and (c) let the tested
// code read `input.files` after assignment. They are installed on
// globalThis ONLY when the runtime does not already provide them, so the
// polyfills never mask a real browser API.

interface DTItem {
  readonly kind: 'file'
  readonly type: string
  getAsFile(): File | null
}

class FakeFileList {
  private readonly items: File[]
  constructor(files: File[]) {
    this.items = files
    for (let i = 0; i < files.length; i += 1) {
      ;(this as unknown as Record<number, File>)[i] = files[i]
    }
  }
  get length(): number {
    return this.items.length
  }
  item(index: number): File | null {
    return this.items[index] ?? null
  }
  *[Symbol.iterator](): IterableIterator<File> {
    for (const f of this.items) yield f
  }
}

class FakeDataTransferItemList {
  private readonly parent: FakeDataTransfer
  constructor(parent: FakeDataTransfer) {
    this.parent = parent
  }
  add(file: File): DTItem | null {
    this.parent._files.push(file)
    return {
      kind: 'file',
      type: file.type,
      getAsFile: () => file,
    }
  }
}

class FakeDataTransfer {
  readonly _files: File[] = []
  readonly items: FakeDataTransferItemList
  constructor(initial?: File[]) {
    this.items = new FakeDataTransferItemList(this)
    if (initial) this._files.push(...initial)
  }
  get files(): FileList {
    return new FakeFileList(this._files) as unknown as FileList
  }
  get types(): readonly string[] {
    return this._files.length > 0 ? ['Files'] : []
  }
}

if (typeof (globalThis as { DataTransfer?: unknown }).DataTransfer === 'undefined') {
  ;(globalThis as { DataTransfer: unknown }).DataTransfer = FakeDataTransfer
}

if (typeof (globalThis as { DragEvent?: unknown }).DragEvent === 'undefined') {
  class FakeDragEvent extends Event {
    readonly dataTransfer: DataTransfer | null
    constructor(type: string, init: EventInit & { dataTransfer?: DataTransfer } = {}) {
      super(type, init)
      this.dataTransfer = init.dataTransfer ?? null
    }
  }
  ;(globalThis as { DragEvent: unknown }).DragEvent = FakeDragEvent
}

if (typeof (globalThis as { ClipboardEvent?: unknown }).ClipboardEvent === 'undefined') {
  class FakeClipboardEvent extends Event {
    readonly clipboardData: DataTransfer | null
    constructor(type: string, init: EventInit & { clipboardData?: DataTransfer } = {}) {
      super(type, init)
      this.clipboardData = init.clipboardData ?? null
    }
  }
  ;(globalThis as { ClipboardEvent: unknown }).ClipboardEvent = FakeClipboardEvent
}

// jsdom validates HTMLInputElement.files assignments against its own native
// FileList. Our polyfilled FakeDataTransfer returns FakeFileList, which
// fails that validation and would prevent both the extraction tests and
// the DataTransfer replay in upload-release from running. Swap the
// prototype accessor so an input.files = X assignment just stores X and
// a read returns whatever was last stored. Only applies in jsdom's
// HTMLInputElement (guarded on typeof HTMLInputElement) and preserves
// the FileList shape for real browsers by not shipping this override.
if (typeof HTMLInputElement !== 'undefined') {
  const filesKey = Symbol('files')
  Object.defineProperty(HTMLInputElement.prototype, 'files', {
    configurable: true,
    get(): FileList | null {
      return (this as unknown as Record<symbol, FileList | null>)[filesKey] ?? null
    },
    set(value: FileList | null): void {
      ;(this as unknown as Record<symbol, FileList | null>)[filesKey] = value
    },
  })
}

// ─── V1.2 M6 XLSX Worker seam ──────────────────────────────────────────────
//
// jsdom has no Web Worker implementation. Production `extractXlsx`
// spawns a Vite `?worker` bundle to run SheetJS; that path is not
// loadable here. Install a synchronous fake WorkerFactory that
// replays the worker's postMessage contract in-line on the main
// thread, so every existing test that walks through `extractText`
// (or `extractXlsx` directly) still exercises the SheetJS parse.
//
// Tests that specifically want to exercise the abort / termination
// path pass their own `workerFactory` via ExtractXlsxOptions — that
// per-call override wins over this global default.

import * as XLSX from 'xlsx'
import {
  __setXlsxWorkerFactoryForTesting,
  type XlsxWorkerLike,
} from '../src/content/extraction/formats/xlsx'

function inlineXlsxWorker(): XlsxWorkerLike {
  const w: XlsxWorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage(message: unknown) {
      // Drive the reply in a microtask so timing matches a real
      // Worker (message events are asynchronous), which prevents
      // tests from accidentally relying on synchronous resolution.
      queueMicrotask(() => {
        if (w.onmessage === null) return
        const { buf } = (message as { buf: ArrayBuffer }) ?? { buf: new ArrayBuffer(0) }
        try {
          const wb = XLSX.read(buf, { type: 'array' })
          if (!wb.SheetNames || wb.SheetNames.length === 0) {
            w.onmessage?.(new MessageEvent('message', { data: { kind: 'reason' } }))
            return
          }
          const parts: string[] = []
          for (const name of wb.SheetNames) {
            const sheet = wb.Sheets[name]
            if (!sheet) continue
            parts.push(XLSX.utils.sheet_to_csv(sheet))
          }
          w.onmessage?.(
            new MessageEvent('message', { data: { kind: 'text', text: parts.join('\n\n') } }),
          )
        } catch {
          w.onmessage?.(new MessageEvent('message', { data: { kind: 'reason' } }))
        }
      })
    },
    terminate() {
      // Fake terminate — drops the reply-fire ability by clearing
      // onmessage so a queued reply after termination is inert.
      w.onmessage = null
      w.onerror = null
    },
  }
  return w
}

__setXlsxWorkerFactoryForTesting(inlineXlsxWorker)
