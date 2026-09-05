// Typed wrappers over chrome.storage.local for the schema in ARCHITECTURE.md.

import {
  SELF_TEST_SIGNAL_KEY,
  SELF_TEST_RESULT_KEY,
  type SelfTestSignal,
  type SelfTestResultRecord,
} from './self-test'

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

// ─── V1.3 M1 submit-protection session kill switch ──────────────────
//
// Written by `SubmitCore` when an adapter's `resume()` fails
// `RESUME_FAILURE_KILL_THRESHOLD` times in a row; read by the popup
// so the user is told "send protection is off for <site> this
// session" rather than silently losing sends. Metadata only: the
// adapter id and a timestamp. Cleared on the next successful startup
// by the service worker in a later milestone; M1 only defines it.

export interface SubmitKillSwitch {
  readonly adapterId: string
  readonly ts: number
}

export async function getSubmitKillSwitch(): Promise<SubmitKillSwitch | null> {
  const stored = await chrome.storage.local.get('submitKillSwitch')
  const raw = stored.submitKillSwitch as Partial<SubmitKillSwitch> | undefined
  if (!raw || typeof raw.adapterId !== 'string' || typeof raw.ts !== 'number') return null
  return { adapterId: raw.adapterId, ts: raw.ts }
}

export async function setSubmitKillSwitch(value: SubmitKillSwitch | null): Promise<void> {
  if (value === null) {
    await chrome.storage.local.remove('submitKillSwitch')
    return
  }
  await chrome.storage.local.set({
    submitKillSwitch: { adapterId: value.adapterId, ts: value.ts },
  })
}

// ── V1.3 M5 self-test coordination (metadata-only, one-shot keys) ──

export async function getSelfTestSignal(): Promise<SelfTestSignal | null> {
  const stored = await chrome.storage.local.get(SELF_TEST_SIGNAL_KEY)
  const raw = stored[SELF_TEST_SIGNAL_KEY] as Partial<SelfTestSignal> | undefined
  if (!raw || typeof raw.nonce !== 'string' || typeof raw.ts !== 'number') return null
  return { nonce: raw.nonce, ts: raw.ts, site: typeof raw.site === 'string' ? raw.site : '' }
}

export async function setSelfTestSignal(value: SelfTestSignal): Promise<void> {
  await chrome.storage.local.set({
    [SELF_TEST_SIGNAL_KEY]: { nonce: value.nonce, ts: value.ts, site: value.site },
  })
}

export async function clearSelfTestSignal(): Promise<void> {
  await chrome.storage.local.remove(SELF_TEST_SIGNAL_KEY)
}

export async function setSelfTestResult(value: SelfTestResultRecord): Promise<void> {
  await chrome.storage.local.set({ [SELF_TEST_RESULT_KEY]: value })
}

export async function getSelfTestResult(): Promise<SelfTestResultRecord | null> {
  const stored = await chrome.storage.local.get(SELF_TEST_RESULT_KEY)
  const raw = stored[SELF_TEST_RESULT_KEY] as Partial<SelfTestResultRecord> | undefined
  if (!raw || typeof raw.result !== 'string' || typeof raw.code !== 'string') return null
  if (typeof raw.nonce !== 'string' || typeof raw.ts !== 'string') return null
  return {
    nonce: raw.nonce,
    result: raw.result,
    code: raw.code,
    site: typeof raw.site === 'string' ? raw.site : '',
    adapter: typeof raw.adapter === 'string' ? raw.adapter : '',
    composer: raw.composer === 1 ? 1 : 0,
    intercept: raw.intercept === 1 ? 1 : 0,
    modal: raw.modal === 1 ? 1 : 0,
    ts: raw.ts,
  }
}

export async function clearSelfTestResult(): Promise<void> {
  await chrome.storage.local.remove(SELF_TEST_RESULT_KEY)
}
