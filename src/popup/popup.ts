import { getCounters, getPrefs, setPrefs } from '../shared/storage'
import { localDateKey } from '../shared/counter'
import { getEvents, summariseEvents, type AlgEvent } from '../shared/event-log'
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

  const viewAll = document.getElementById('view-all-activity')
  if (viewAll !== null) {
    viewAll.addEventListener('click', () => {
      // `openOptionsPage` opens the extension's `options_ui` page —
      // no new permission required. Guard against a stubbed
      // environment (some MV3 unit-test contexts don't populate
      // `chrome.runtime`) so the click is a silent no-op instead of
      // throwing.
      const runtime = (
        globalThis as unknown as { chrome?: { runtime?: { openOptionsPage?: () => void } } }
      ).chrome?.runtime
      if (runtime && typeof runtime.openOptionsPage === 'function') {
        try {
          runtime.openOptionsPage()
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
