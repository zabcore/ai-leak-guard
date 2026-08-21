// V1.2 A5.1 full-activity page controller.
//
// Renders the entire local metadata event log (up to
// `MAX_EVENTS`) newest-first, with a per-row breakdown of
// timestamp, site, event type, action, category chips, and item
// count. Empty-state copy on a fresh install. Export controls
// (CSV + JSON) live on this page; the popup keeps only the
// compact recent slice + a "View all activity →" link that opens
// this page via `chrome.runtime.openOptionsPage()`.
//
// Metadata-only rendering everywhere — every row cell uses
// `textContent` from AlgEvent schema fields; nothing here reads
// content, and the AlgEvent shape has no `value` / `text` /
// `filename` field to accidentally leak in the first place.
//
// `getEvents` is documented never-throws; a broken storage read
// degrades to the empty state rather than a red error banner.

import type { DetectorCategory } from '../detector/types'
import { getEvents, MAX_EVENTS, type AlgEvent } from '../shared/event-log'
import { actionLabel, categoryLabel, relativeTime, siteLabel } from './labels'
import { exportCsv, exportJson } from './export'

/**
 * Human-readable absolute timestamp for the row's "abs" line.
 * Kept locale-aware so the reader sees their own timezone.
 */
function absoluteTime(ts: number): string {
  try {
    return new Date(ts).toLocaleString()
  } catch {
    return new Date(ts).toISOString()
  }
}

/** Render one row into a `<tbody>`. Metadata-only, `textContent`-driven. */
function renderRow(tbody: HTMLElement, event: AlgEvent, now: number): void {
  const tr = document.createElement('tr')

  const when = document.createElement('td')
  when.className = 'activity__cell-when'
  const whenRel = document.createElement('div')
  whenRel.textContent = relativeTime(event.ts, now)
  const whenAbs = document.createElement('div')
  whenAbs.className = 'activity__cell-time-abs'
  whenAbs.textContent = absoluteTime(event.ts)
  when.append(whenRel, whenAbs)

  const site = document.createElement('td')
  site.textContent = siteLabel(event.site)

  const type = document.createElement('td')
  type.textContent = event.eventType

  const action = document.createElement('td')
  const actionBadge = document.createElement('span')
  actionBadge.className = `activity__action activity__action--${event.action}`
  actionBadge.textContent = actionLabel(event.action)
  action.appendChild(actionBadge)

  const cats = document.createElement('td')
  cats.className = 'activity__cell-chips'
  if (event.categories.length === 0) {
    const dim = document.createElement('span')
    dim.textContent = '—'
    dim.style.color = '#9ca3af'
    cats.appendChild(dim)
  } else {
    for (const cat of event.categories) {
      const chip = document.createElement('span')
      chip.className = event.hadCriticalOrHigh
        ? 'activity__chip activity__chip--critical'
        : 'activity__chip'
      chip.textContent = categoryLabel(cat as DetectorCategory)
      cats.appendChild(chip)
    }
  }

  const count = document.createElement('td')
  count.className = 'activity__cell-count'
  count.textContent = event.count > 0 ? String(event.count) : '—'

  tr.append(when, site, type, action, cats, count)
  tbody.appendChild(tr)
}

/** Main render — reads storage once, populates the DOM. */
async function render(): Promise<void> {
  const meta = document.getElementById('activity-meta')
  const empty = document.getElementById('empty-state')
  const wrap = document.getElementById('table-wrap')
  const tbody = document.getElementById('activity-rows')
  const exportCsvBtn = document.getElementById('export-csv')
  const exportJsonBtn = document.getElementById('export-json')

  let events: readonly AlgEvent[] = []
  try {
    events = await getEvents()
  } catch (err) {
    // getEvents is documented never-throws; belt-and-braces here
    // so a broken storage read renders empty rather than a stack.
    console.warn('[AI Leak Guard] activity page: read failed', err)
    events = []
  }

  if (empty !== null && wrap !== null) {
    if (events.length === 0) {
      empty.hidden = false
      wrap.hidden = true
    } else {
      empty.hidden = true
      wrap.hidden = false
    }
  }

  if (meta !== null) {
    if (events.length === 0) {
      meta.textContent = ''
    } else {
      const noun = events.length === 1 ? 'event' : 'events'
      const cap = events.length >= MAX_EVENTS ? ` · showing the most recent ${MAX_EVENTS}` : ''
      meta.textContent = `${events.length} ${noun}${cap}`
    }
  }

  if (tbody !== null) {
    tbody.replaceChildren()
    const now = Date.now()
    // Storage is oldest-first; the reader wants newest-first.
    for (let i = events.length - 1; i >= 0; i--) {
      renderRow(tbody, events[i], now)
    }
  }

  // Wire export buttons to the exporters — each pulls a fresh
  // snapshot of storage at click time so a burst of new events
  // that landed while the page was open still ends up in the
  // export. Disable both buttons when the log is empty (no CSV
  // to build).
  const empty0 = events.length === 0
  if (exportCsvBtn instanceof HTMLButtonElement) {
    exportCsvBtn.disabled = empty0
    exportCsvBtn.onclick = () => {
      void (async () => {
        try {
          const fresh = await getEvents()
          exportCsv(fresh)
        } catch (err) {
          console.warn('[AI Leak Guard] CSV export failed:', err)
        }
      })()
    }
  }
  if (exportJsonBtn instanceof HTMLButtonElement) {
    exportJsonBtn.disabled = empty0
    exportJsonBtn.onclick = () => {
      void (async () => {
        try {
          const fresh = await getEvents()
          exportJson(fresh)
        } catch (err) {
          console.warn('[AI Leak Guard] JSON export failed:', err)
        }
      })()
    }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  void render()
})

// Test seam — the DOMContentLoaded auto-invoke can't run in the
// test's synchronous flow because vitest imports the module
// AFTER the fake DOM is built. Re-exporting `render` (and
// `renderRow` for a per-row test) gives the popup-activity test
// a deterministic entry point.
export { render as __renderForTests, renderRow as __renderRowForTests }
