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
  remove: async (keys: string | string[]): Promise<void> => {
    for (const key of Array.isArray(keys) ? keys : [keys]) store.delete(key)
  },
}

// Minimal `chrome.runtime` shim covering both the worker-URL
// resolver (#39 — `getURL`) and the A5 event-log's cross-process
// `sendMessage` path (#40 CR — writes now live in the service
// worker so concurrent tabs don't race). In tests there IS no
// real service worker, so the shim performs the append inline
// against `chrome.storage.local` — same read-modify-write logic
// the production service worker uses, just running in-process.
const FAKE_EXTENSION_ID = 'testextidtestextidtestextidtestex'

// Same MAX_EVENTS as production — kept as a literal here so this
// shim doesn't need to import the schema module at test-setup
// eval time (which would create an import cycle for tests
// stubbing the event-log module).
const SHIM_MAX_EVENTS = 200
const SHIM_STORAGE_KEY = 'events'
const SHIM_APPEND_TYPE = 'alg-event-append'

interface ShimEventShape {
  ts: number
  site: string
  eventType: 'paste' | 'document' | 'submit'
  action: string
  categories: readonly string[]
  count: number
  hadCriticalOrHigh: boolean
}

const ALLOWED_ACTIONS = new Set([
  'protected',
  'as-is',
  'cancelled',
  'uploaded-anyway',
  'auto-cleared',
  'unable-to-inspect',
])

// Same values as `DetectorCategory` in `src/detector/types.ts`,
// inlined for the same reason `SHIM_MAX_EVENTS` is (avoids an
// import cycle at test-setup eval time). If the production
// allowlist ever adds a category, mirror it here so the shim
// stays consistent with the real service worker's projection.
const ALLOWED_CATEGORIES = new Set([
  'identity',
  'healthcare_patient_id',
  'government_financial',
  'provider_id',
  'clinical_context',
  'developer_credential',
])

function shimProject(x: unknown): ShimEventShape | null {
  if (x === null || typeof x !== 'object') return null
  const r = x as Record<string, unknown>
  if (typeof r.ts !== 'number' || !Number.isFinite(r.ts) || r.ts < 0) return null
  if (typeof r.site !== 'string') return null
  if (r.eventType !== 'paste' && r.eventType !== 'document' && r.eventType !== 'submit') return null
  if (typeof r.action !== 'string' || !ALLOWED_ACTIONS.has(r.action)) return null
  if (!Array.isArray(r.categories)) return null
  if (r.categories.some((c) => typeof c !== 'string' || !ALLOWED_CATEGORIES.has(c))) return null
  if (typeof r.count !== 'number' || !Number.isFinite(r.count) || r.count < 0) return null
  if (typeof r.hadCriticalOrHigh !== 'boolean') return null
  return {
    ts: r.ts,
    site: r.site,
    eventType: r.eventType,
    action: r.action,
    categories: r.categories as string[],
    count: r.count,
    hadCriticalOrHigh: r.hadCriticalOrHigh,
  }
}

let shimWriteChain: Promise<void> = Promise.resolve()

async function shimAppendOne(rawEvent: unknown): Promise<void> {
  const projected = shimProject(rawEvent)
  if (projected === null) return
  const stored = await local.get(SHIM_STORAGE_KEY)
  const raw = stored[SHIM_STORAGE_KEY]
  const current = Array.isArray(raw) ? (raw.filter(shimProject) as ShimEventShape[]) : []
  const next =
    current.length >= SHIM_MAX_EVENTS
      ? [...current.slice(-SHIM_MAX_EVENTS + 1), projected]
      : [...current, projected]
  const trimmed = next.length > SHIM_MAX_EVENTS ? next.slice(-SHIM_MAX_EVENTS) : next
  await local.set({ [SHIM_STORAGE_KEY]: trimmed })
}

// `onMessage.addListener` shim — the service-worker module wires
// its append handler through here at import time, and without a
// stub the import throws with "Cannot read properties of
// undefined (reading 'addListener')". Tests that need to invoke
// the handler directly can pull it off `runtime.onMessage.__listeners`.
interface MessageListener {
  (message: unknown, sender: unknown, sendResponse: (response?: unknown) => void): boolean | void
}
const messageListeners: MessageListener[] = []
const onMessage = {
  __listeners: messageListeners,
  addListener: (fn: MessageListener) => {
    messageListeners.push(fn)
  },
}

// M6 onInstalled shim — the service worker wires
// `chrome.runtime.onInstalled.addListener` at import time, same
// reason `onMessage` needs a stub above.
interface InstalledListener {
  (details: { reason: string }): void
}
const installedListeners: InstalledListener[] = []
const onInstalled = {
  __listeners: installedListeners,
  addListener: (fn: InstalledListener) => {
    installedListeners.push(fn)
  },
}

const runtime = {
  onMessage,
  onInstalled,
  getURL: (path: string): string => {
    const rel = path.startsWith('/') ? path.slice(1) : path
    return `chrome-extension://${FAKE_EXTENSION_ID}/${rel}`
  },
  sendMessage: async (message: unknown): Promise<{ ok: true } | undefined> => {
    if (
      message === null ||
      typeof message !== 'object' ||
      (message as Record<string, unknown>).type !== SHIM_APPEND_TYPE
    ) {
      return undefined
    }
    const rawEvent = (message as Record<string, unknown>).event
    const done = shimWriteChain.then(() => shimAppendOne(rawEvent))
    shimWriteChain = done.then(
      () => undefined,
      () => undefined,
    )
    await done
    return { ok: true }
  },
}

// M6 tabs shim — the service worker calls `chrome.tabs.create`
// from the onInstalled listener. The shim records calls so the
// onInstalled test (and any future release-flow test) can assert
// what URL fired. `tabs.create` in MV3 returns Promise<Tab>; we
// resolve to a stub tab object so the handler's `.then` chain
// doesn't blow up on a non-promise return.
interface TabsCreateOpts {
  readonly url: string
}
const tabsCalls: TabsCreateOpts[] = []
const tabs = {
  __calls: tabsCalls,
  create: async (opts: TabsCreateOpts): Promise<{ id: number; url: string }> => {
    tabsCalls.push(opts)
    return { id: 1, url: opts.url }
  },
}

;(
  globalThis as unknown as {
    chrome: {
      storage: { local: typeof local }
      runtime: typeof runtime
      tabs: typeof tabs
    }
  }
).chrome = {
  storage: { local },
  runtime,
  tabs,
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
  // Real browsers implement `getData` and return '' for any MIME
  // slot that isn't set — including a file-only clipboard where
  // string MIMEs are absent. Without this the shim throws
  // "getData is not a function" and callers that distinguish
  // "read failed" from "slot empty" (e.g. `readPastedText`) see
  // a false read-error signal.
  getData(_type: string): string {
    return ''
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
