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
