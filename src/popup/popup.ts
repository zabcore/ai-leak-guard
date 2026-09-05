import {
  getCounters,
  getPrefs,
  setPrefs,
  getSubmitKillSwitch,
  setSelfTestSignal,
  getSelfTestResult,
  clearSelfTestResult,
} from '../shared/storage'
import { localDateKey } from '../shared/counter'
import { getEvents, summariseEvents, type AlgEvent } from '../shared/event-log'
import {
  SELF_TEST_RESULT_KEY,
  SELF_TEST_POPUP_TIMEOUT_MS,
  type SelfTestResultKind,
  type SelfTestCode,
  type SelfTestResultRecord,
} from '../shared/self-test'
import { buildSelfTestReportUrl, coarseBrowser } from '../shared/self-test-report'
import { siteLabel, actionLabel, relativeTime } from './labels'

function setToggleLabel(enabled: boolean): void {
  const label = document.getElementById('toggle-label')
  if (label !== null) label.textContent = enabled ? 'Enabled' : 'Disabled'
}

/**
 * Build the compact per-event line ("ChatGPT · document · 3 items ·
 * uploaded anyway · 2m ago"). Everything comes from the AlgEvent —
 * no raw values, no filenames, ever. Kept exported so a component
 * test can pin the string shape without a DOM.
 */
export function formatRecentLine(event: AlgEvent, now: number = Date.now()): string {
  const parts = [siteLabel(event.site), event.eventType]
  if (event.count > 0) {
    parts.push(`${event.count} item${event.count === 1 ? '' : 's'}`)
  } else if (event.action === 'auto-cleared') {
    parts.push('clean')
  }
  parts.push(actionLabel(event.action))
  parts.push(relativeTime(event.ts, now))
  return parts.join(' · ')
}

/** How many recent events to render. Kept small for popup real estate. */
const RECENT_LIMIT = 8

/**
 * Render the A5 activity section from the event log. Pure DOM
 * write — reads the log lazily so the popup opens instantly and
 * the numbers appear as soon as storage answers.
 */
async function renderActivity(): Promise<void> {
  const section = document.getElementById('activity-section')
  if (section === null) return
  let events: readonly AlgEvent[]
  try {
    events = await getEvents()
  } catch {
    // Storage read shouldn't reject (`getEvents` catches), but
    // even if it does we hide the section and leave the classic
    // total/today counters intact.
    section.hidden = true
    return
  }

  if (events.length === 0) {
    section.hidden = true
    return
  }
  section.hidden = false

  const summary = summariseEvents(events)
  setText('stat-detected', String(summary.detected))
  setText('stat-protected', String(summary.protectedCount))
  setText('stat-as-is-or-released', String(summary.asIs + summary.uploadedAnyway))
  setText('stat-cancelled', String(summary.cancelled))

  // Per-site breakdown — sort by count desc, tie-break by label.
  const perSiteSection = document.getElementById('per-site-section')
  const perSiteList = document.getElementById('per-site-list')
  if (perSiteSection instanceof HTMLElement && perSiteList !== null) {
    const rows = Object.entries(summary.perSite).sort(
      (a, b) => b[1] - a[1] || siteLabel(a[0]).localeCompare(siteLabel(b[0])),
    )
    if (rows.length <= 1) {
      // A single site is uninformative; skip the section entirely.
      perSiteSection.hidden = true
    } else {
      perSiteSection.hidden = false
      perSiteList.replaceChildren()
      for (const [id, count] of rows) {
        const li = document.createElement('li')
        const label = document.createElement('span')
        label.className = 'activity__site-label'
        label.textContent = siteLabel(id)
        const num = document.createElement('span')
        num.className = 'activity__site-count'
        num.textContent = String(count)
        li.append(label, num)
        perSiteList.appendChild(li)
      }
    }
  }

  // Recent activity — most-recent first, cap at RECENT_LIMIT.
  const recentSection = document.getElementById('recent-section')
  const recentList = document.getElementById('recent-list')
  if (recentSection instanceof HTMLElement && recentList !== null) {
    // `events` is stored oldest-first; reverse for the tail slice.
    const recent = [...events].reverse().slice(0, RECENT_LIMIT)
    recentSection.hidden = recent.length === 0
    recentList.replaceChildren()
    for (const event of recent) {
      const li = document.createElement('li')
      // `textContent` is the ONLY way we write to the recent list.
      // No innerHTML, no attribute injection — the AlgEvent shape
      // has no content fields to accidentally leak in the first
      // place, but this keeps the popup DOM defensively clean.
      li.textContent = formatRecentLine(event)
      recentList.appendChild(li)
    }
  }
}

function setText(id: string, text: string): void {
  const el = document.getElementById(id)
  if (el !== null) el.textContent = text
}

/**
 * V1.3 M1 — surface the send-protection session kill switch so a
 * user whose adapter was disabled (repeated resume failures) is
 * told, rather than silently losing send protection on that site.
 * Renders nothing unless the flag is set; in M1 it never is.
 * Exported so a component test can pin the copy without a DOM.
 */
export function formatKillSwitchLine(adapterId: string): string {
  return `Send protection is paused on ${siteLabel(adapterId)} for this session (the site's own send is unaffected).`
}

async function renderSubmitKillSwitch(): Promise<void> {
  const el = document.getElementById('submit-killswitch')
  if (!(el instanceof HTMLElement)) return
  let flag: Awaited<ReturnType<typeof getSubmitKillSwitch>> = null
  try {
    flag = await getSubmitKillSwitch()
  } catch {
    flag = null
  }
  if (flag === null) {
    el.hidden = true
    el.textContent = ''
    return
  }
  el.textContent = formatKillSwitchLine(flag.adapterId)
  el.hidden = false
}

async function render(): Promise<void> {
  const [counters, prefs] = await Promise.all([getCounters(), getPrefs()])

  const total = document.getElementById('total')
  const today = document.getElementById('today')
  const caption = document.querySelector('.popup__caption')
  const toggle = document.getElementById('toggle')

  if (total !== null) total.textContent = String(counters.total)
  if (today !== null) today.textContent = String(counters.byDay[localDateKey()] ?? 0)
  // Unit clarity: singular vs plural on the headline caption so a
  // stray "1 sensitive items masked" doesn't undercut the point of
  // the label. Metadata only — the caption never renders a value.
  if (caption !== null) {
    caption.textContent = counters.total === 1 ? 'Sensitive item masked' : 'Sensitive items masked'
  }
  if (toggle instanceof HTMLInputElement) toggle.checked = prefs.enabled
  setToggleLabel(prefs.enabled)

  // A5 activity section is best-effort — a rendering failure must
  // not break the toggle or the total-masked count above.
  try {
    await renderActivity()
  } catch (err) {
    console.warn('[AI Leak Guard] popup activity render failed:', err)
  }
  // V1.3 M1 kill-switch notice — same best-effort posture.
  try {
    await renderSubmitKillSwitch()
  } catch (err) {
    console.warn('[AI Leak Guard] popup kill-switch render failed:', err)
  }
}

// ── V1.3 M5 — one-click self-test ──

/** Supported submit sites the self-test can open a fresh tab on. */
const SELF_TEST_SITES: ReadonlyArray<{ id: string; origin: string; match: RegExp }> = [
  {
    id: 'chatgpt',
    origin: 'https://chatgpt.com/',
    match: /^https:\/\/(chatgpt\.com|chat\.openai\.com)\//,
  },
  { id: 'claude', origin: 'https://claude.ai/', match: /^https:\/\/claude\.ai\// },
  { id: 'gemini', origin: 'https://gemini.google.com/', match: /^https:\/\/gemini\.google\.com\// },
]

/**
 * Pick which supported site to open a fresh tab on. Prefer an
 * already-open supported tab's origin (so the test runs where the user
 * already works), else default to ChatGPT. Pure — exported for tests.
 */
export function pickSelfTestSite(tabUrls: readonly string[]): { id: string; origin: string } {
  for (const url of tabUrls) {
    const site = SELF_TEST_SITES.find((s) => s.match.test(url))
    if (site !== undefined) return { id: site.id, origin: site.origin }
  }
  const fallback = SELF_TEST_SITES[0]
  return { id: fallback.id, origin: fallback.origin }
}

/**
 * The honest (A-5) result line. It states the self-test validated
 * DETECTION + the WARNING on this site — NOT trusted-event resumption
 * or that an actual message was sent. Pure — exported for tests.
 */
export function selfTestResultCopy(result: SelfTestResultKind, code: SelfTestCode): string {
  if (result === 'confirmed') {
    return 'Protection confirmed — detection and the send-time warning are working on this site. This checks detection + the warning, not that a real message was sent.'
  }
  if (result === 'unsupported') {
    return 'Protection isn’t active on this page — open a supported AI site and try again.'
  }
  if (code === 'TIMEOUT') {
    return 'Couldn’t start the test — refresh the page and try again.'
  }
  return 'Couldn’t complete the test — refresh the page and try again.'
}

function makeNonce(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  return `st-${Date.now()}-${Math.floor(Math.random() * 1e9)}`
}

async function chooseSelfTestSite(): Promise<{ id: string; origin: string }> {
  try {
    const tabsApi = (globalThis as unknown as { chrome?: typeof chrome }).chrome?.tabs
    if (tabsApi && typeof tabsApi.query === 'function') {
      const tabs = await tabsApi.query({})
      const urls = tabs.map((t) => t.url ?? '').filter((u) => u.length > 0)
      return pickSelfTestSite(urls)
    }
  } catch {
    // fall through to default
  }
  const fallback = SELF_TEST_SITES[0]
  return { id: fallback.id, origin: fallback.origin }
}

/** Wait for the content script to write a result with a matching nonce (or time out). */
function waitForSelfTestResult(
  nonce: string,
  timeoutMs: number,
): Promise<SelfTestResultRecord | null> {
  return new Promise((resolve) => {
    const storage = (
      globalThis as unknown as {
        chrome?: {
          storage?: {
            local?: { get?: (k: string) => Promise<Record<string, unknown>> }
            onChanged?: {
              addListener: (
                fn: (c: Record<string, { newValue?: unknown }>, a: string) => void,
              ) => void
              removeListener: (
                fn: (c: Record<string, { newValue?: unknown }>, a: string) => void,
              ) => void
            }
          }
        }
      }
    ).chrome?.storage
    let done = false
    const finish = (rec: SelfTestResultRecord | null): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (storage?.onChanged) storage.onChanged.removeListener(onChange)
      resolve(rec)
    }
    const consider = (raw: unknown): void => {
      const rec = raw as Partial<SelfTestResultRecord> | undefined
      if (rec && rec.nonce === nonce && typeof rec.result === 'string') {
        finish(rec as SelfTestResultRecord)
      }
    }
    const onChange = (changes: Record<string, { newValue?: unknown }>, area: string): void => {
      if (area !== 'local') return
      const change = changes[SELF_TEST_RESULT_KEY]
      if (change !== undefined) consider(change.newValue)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    if (storage?.onChanged) storage.onChanged.addListener(onChange)
    // Cover the race where the result already landed before we listened.
    if (storage?.local?.get) {
      void storage.local.get(SELF_TEST_RESULT_KEY).then((s) => consider(s[SELF_TEST_RESULT_KEY]))
    }
  })
}

export function renderSelfTestOutcome(record: SelfTestResultRecord): void {
  const resultEl = document.getElementById('selftest-result')
  const reportEl = document.getElementById('selftest-report')
  if (resultEl !== null) {
    resultEl.hidden = false
    resultEl.textContent = selfTestResultCopy(record.result, record.code)
  }
  if (reportEl instanceof HTMLElement) {
    const needsReport = record.result === 'fail' || record.result === 'unsupported'
    reportEl.hidden = !needsReport
    if (needsReport) {
      reportEl.onclick = (): void => openSelfTestReport(record)
    } else {
      reportEl.onclick = null
    }
  }
}

function extVersion(): string {
  try {
    const runtime = (globalThis as unknown as { chrome?: typeof chrome }).chrome?.runtime
    return runtime?.getManifest?.().version ?? ''
  } catch {
    return ''
  }
}

function openSelfTestReport(record: SelfTestResultRecord): void {
  const url = buildSelfTestReportUrl({
    site: record.site,
    ext: extVersion(),
    adapter: record.adapter,
    result: record.result,
    code: record.code,
    composer: record.composer,
    intercept: record.intercept,
    modal: record.modal,
    browser: coarseBrowser(
      (globalThis as unknown as { navigator?: { userAgent?: string } }).navigator?.userAgent,
    ),
    ts: record.ts,
  })
  const tabsApi = (globalThis as unknown as { chrome?: typeof chrome }).chrome?.tabs
  if (tabsApi && typeof tabsApi.create === 'function') {
    try {
      void tabsApi.create({ url })
    } catch (err) {
      console.warn('[AI Leak Guard] report tab failed to open:', err)
    }
  }
}

async function startSelfTest(): Promise<void> {
  const btn = document.getElementById('selftest-btn')
  const resultEl = document.getElementById('selftest-result')
  const reportEl = document.getElementById('selftest-report')
  if (reportEl instanceof HTMLElement) reportEl.hidden = true
  if (resultEl !== null) {
    resultEl.hidden = false
    resultEl.textContent = 'Opening a test tab — the result will appear in that tab.'
  }
  if (btn instanceof HTMLButtonElement) btn.disabled = true

  try {
    await clearSelfTestResult()
    const nonce = makeNonce()
    const site = await chooseSelfTestSite()
    await setSelfTestSignal({ nonce, ts: Date.now(), site: site.origin })
    const tabsApi = (globalThis as unknown as { chrome?: typeof chrome }).chrome?.tabs
    if (tabsApi && typeof tabsApi.create === 'function') {
      void tabsApi.create({ url: `${site.origin}#alg-selftest` })
    }
    const record = await waitForSelfTestResult(nonce, SELF_TEST_POPUP_TIMEOUT_MS)
    if (record === null) {
      // No result in time → "couldn't start". Offer a report with what
      // little we know (all diagnostics zero, code TIMEOUT).
      renderSelfTestOutcome({
        nonce,
        result: 'fail',
        code: 'TIMEOUT',
        site: site.id,
        adapter: site.id,
        composer: 0,
        intercept: 0,
        modal: 0,
        ts: new Date().toISOString(),
      })
    } else {
      renderSelfTestOutcome(record)
    }
  } catch (err) {
    console.warn('[AI Leak Guard] self-test failed to start:', err)
    if (resultEl !== null) resultEl.textContent = selfTestResultCopy('fail', 'TIMEOUT')
  } finally {
    // Only re-enable the button here. The result is written by the
    // content script and shown IN THE TEST TAB (the popup usually closed
    // when the tab took focus); clearing it here — in a `finally` that
    // often never runs — would just drop the record the reopened popup
    // wants to surface. The record is cleared on the next test start
    // and after `renderLastSelfTestResult` shows it on reopen.
    if (btn instanceof HTMLButtonElement) btn.disabled = false
  }
}

/**
 * On popup open, surface a RECENT self-test result the content script
 * wrote while the popup was closed. Stale results (older than the window
 * below) are ignored and cleared so a week-old outcome never resurfaces.
 */
export const SELF_TEST_RESULT_FRESH_MS = 2 * 60 * 1000
export async function renderLastSelfTestResult(now: number = Date.now()): Promise<void> {
  let record: Awaited<ReturnType<typeof getSelfTestResult>> = null
  try {
    record = await getSelfTestResult()
  } catch {
    record = null
  }
  if (record === null) return
  const ageMs = now - Date.parse(record.ts)
  // Consume the one-shot record either way (shown or too old).
  try {
    await clearSelfTestResult()
  } catch {
    // best-effort
  }
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > SELF_TEST_RESULT_FRESH_MS) return
  renderSelfTestOutcome(record)
}

async function init(): Promise<void> {
  // Render initial state from storage BEFORE wiring the change listener so the
  // programmatic checked-state assignment can't be observed as a user change.
  await render()

  const toggle = document.getElementById('toggle')
  if (toggle instanceof HTMLInputElement) {
    toggle.addEventListener('change', () => {
      setToggleLabel(toggle.checked)
      void setPrefs({ enabled: toggle.checked })
    })
  }

  const selfTestBtn = document.getElementById('selftest-btn')
  if (selfTestBtn !== null) {
    selfTestBtn.addEventListener('click', () => {
      void startSelfTest()
    })
  }
  // Surface a recent result the content script wrote while the popup was
  // closed (Chrome dismisses the popup when the test tab takes focus).
  try {
    await renderLastSelfTestResult()
  } catch (err) {
    console.warn('[AI Leak Guard] self-test result render failed:', err)
  }

  const viewAll = document.getElementById('view-all-activity')
  if (viewAll !== null) {
    viewAll.addEventListener('click', () => {
      // `openOptionsPage` opens the extension's `options_ui` page —
      // no new permission required. Guard against a stubbed
      // environment (some MV3 unit-test contexts don't populate
      // `chrome.runtime`) so the click is a silent no-op instead of
      // throwing.
      //
      // In MV3 `openOptionsPage` returns `Promise<void>`; a rejected
      // promise (extension missing an options page, browser refuses
      // to open it, etc.) would otherwise become an unhandled
      // rejection. The `try/catch` still catches synchronous
      // throws from older polyfills / callback-shim shapes; the
      // `.catch` handler routes async rejections into the same
      // warning path.
      const runtime = (
        globalThis as unknown as {
          chrome?: { runtime?: { openOptionsPage?: () => void | Promise<void> } }
        }
      ).chrome?.runtime
      if (runtime && typeof runtime.openOptionsPage === 'function') {
        try {
          const result = runtime.openOptionsPage() as void | Promise<void>
          if (result && typeof (result as Promise<void>).then === 'function') {
            void (result as Promise<void>).catch((err: unknown) => {
              console.warn('[AI Leak Guard] openOptionsPage failed:', err)
            })
          }
        } catch (err) {
          console.warn('[AI Leak Guard] openOptionsPage failed:', err)
        }
      }
    })
  }
}

document.addEventListener('DOMContentLoaded', () => {
  void init()
})
