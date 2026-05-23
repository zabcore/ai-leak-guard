// Typed wrappers over chrome.storage.local for the schema in ARCHITECTURE.md.

export interface Counters {
  total: number
  byType: Record<string, number>
  byDay: Record<string, number>
}

export interface Prefs {
  enabled: boolean
  rulesUpdatedAt: number
}

const DEFAULT_COUNTERS: Counters = { total: 0, byType: {}, byDay: {} }
const DEFAULT_PREFS: Prefs = { enabled: true, rulesUpdatedAt: 0 }

export async function getCounters(): Promise<Counters> {
  const stored = await chrome.storage.local.get('counters')
  const counters = stored.counters as Partial<Counters> | undefined
  return {
    total: counters?.total ?? DEFAULT_COUNTERS.total,
    byType: counters?.byType ?? {},
    byDay: counters?.byDay ?? {},
  }
}

export async function setCounters(counters: Counters): Promise<void> {
  await chrome.storage.local.set({ counters })
}

export async function getPrefs(): Promise<Prefs> {
  const stored = await chrome.storage.local.get('prefs')
  const prefs = stored.prefs as Partial<Prefs> | undefined
  return {
    enabled: prefs?.enabled ?? DEFAULT_PREFS.enabled,
    rulesUpdatedAt: prefs?.rulesUpdatedAt ?? DEFAULT_PREFS.rulesUpdatedAt,
  }
}

export async function setPrefs(prefs: Partial<Prefs>): Promise<void> {
  const current = await getPrefs()
  await chrome.storage.local.set({ prefs: { ...current, ...prefs } })
}
