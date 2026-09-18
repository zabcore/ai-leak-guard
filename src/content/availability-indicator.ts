// V1.3.3/V1.3.4 — the compact in-page AVAILABILITY indicator.
//
// A small pill that renders ONLY where the extension is active here (a composer
// resolves right now + the toggle is on). It states availability, never "you
// are protected", and exposes the signals SEPARATELY (composer / paste / send /
// file scanning / last self-test) — there is no single composite status.
//
// V1.3.4 — presentation only: it defaults to a tiny CHIP (green dot + "AI Leak
// Guard") pinned bottom-LEFT so it never covers the site's composer controls
// (ChatGPT/Claude/Gemini/Perplexity/Copilot all park send / voice / attach /
// scroll-to-bottom controls bottom-RIGHT). On hover / keyboard focus / tap the
// chip expands UPWARD into the full detail panel (header + "What it's checking"
// + the separate signal rows + the "tap Test protection" footer), staying clear
// of the composer, and collapses again on leave / blur. A "×" on the chip hides
// it for this origin (persisted by the caller).
//
// Anti-stale-green by construction: `refresh()` re-reads availability from the
// caller (which resolves the composer live), and removes the host whenever the
// surface is not active — so a prior self-test pass can never keep it on screen
// once the composer is gone. The chip is built ONCE and only the detail values
// are updated on refresh, so a periodic refresh never collapses an open panel
// or steals focus.
//
// It cannot announce its OWN total absence (if the content script never loads,
// nothing renders) — the footer copy says so plainly and points at the toolbar
// "Test protection" action as the way to confirm it's working here.

import type { Availability, SignalState, SelfTestSignalInfo } from './availability'

const HOST_ATTR = 'data-ai-leak-guard-availability'

export interface AvailabilityIndicatorDeps {
  /** Live availability, or null when not on an in-scope surface. */
  readonly getAvailability: () => Availability | null
  /** Where to mount (default `document.body`). */
  readonly mount?: () => ParentNode | null
  /** True when the user dismissed the chip for this origin (default false). */
  readonly isDismissed?: () => boolean
  /** Called when the user clicks the chip's "×" (persist the dismissal). */
  readonly onDismiss?: () => void
}

export interface AvailabilityIndicator {
  /** Re-evaluate availability and (un)render accordingly. Safe to call often. */
  refresh(): void
  /** Remove the host and stop rendering. */
  destroy(): void
}

const STYLE = `
  :host { all: initial; }
  .alg-ind {
    position: fixed; left: 12px; bottom: 12px; z-index: 2147483000;
    display: flex; flex-direction: column; align-items: flex-start; gap: 6px;
    font: 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    color: #0b1324;
  }
  /* The CHIP: the only thing shown collapsed. Interactive, tiny, one line. */
  .alg-ind__chip {
    order: 1; /* below the panel, since the column is anchored at the bottom */
    display: inline-flex; align-items: center; gap: 6px;
    max-width: 210px; white-space: nowrap;
    background: #ffffff; border: 1px solid #d7dbe3; border-radius: 999px;
    box-shadow: 0 2px 10px rgba(11,19,36,0.12);
    padding: 5px 6px 5px 10px; opacity: 0.98;
    pointer-events: auto; cursor: default; user-select: none;
    outline-offset: 2px;
  }
  .alg-ind__chip:focus-visible { outline: 2px solid #1a7f37; }
  .alg-ind__dot { width: 8px; height: 8px; border-radius: 50%; background: #1a7f37; flex: none; }
  .alg-ind__chip-label { font-weight: 600; overflow: hidden; text-overflow: ellipsis; }
  .alg-ind__dismiss {
    all: unset; box-sizing: border-box;
    width: 16px; height: 16px; line-height: 14px; text-align: center;
    border-radius: 50%; color: #5b6472; cursor: pointer; flex: none; font-size: 13px;
  }
  .alg-ind__dismiss:hover { background: #eceef2; color: #0b1324; }
  .alg-ind__dismiss:focus-visible { outline: 2px solid #1a7f37; }
  /* The PANEL: the full detail, shown only when expanded, above the chip. */
  .alg-ind__panel {
    order: 0;
    max-width: 260px; max-height: calc(100vh - 96px); overflow: auto;
    background: #ffffff; border: 1px solid #d7dbe3; border-radius: 10px;
    box-shadow: 0 2px 10px rgba(11,19,36,0.12); padding: 8px 10px; opacity: 0.98;
    pointer-events: auto;
  }
  @media (prefers-reduced-motion: no-preference) {
    .alg-ind__panel { animation: alg-ind-in 120ms ease-out; }
  }
  @keyframes alg-ind-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
  .alg-ind__header { font-weight: 600; display: flex; align-items: center; gap: 6px; }
  .alg-ind__pdot { width: 8px; height: 8px; border-radius: 50%; background: #1a7f37; flex: none; }
  .alg-ind__sub { color: #5b6472; margin: 1px 0 6px; }
  .alg-ind__signals { display: grid; grid-template-columns: 1fr; gap: 2px; }
  .alg-ind__signal { display: flex; justify-content: space-between; gap: 10px; }
  .alg-ind__label { color: #3a4252; }
  .alg-ind__value { color: #0b1324; }
  .alg-ind__value--on { color: #1a7f37; }
  .alg-ind__value--off { color: #8a94a6; }
  .alg-ind__note { color: #5b6472; margin-top: 6px; border-top: 1px solid #eceef2; padding-top: 6px; }
`

// Plain-language values. "On" when the check runs on this surface; otherwise a
// clear, jargon-free state (never a composite "you're protected").
function signalValue(state: SignalState): string {
  if (state === 'ready') return 'On'
  if (state === 'unvalidated') return 'Not confirmed'
  return 'Not available'
}

function selfTestValue(info: SelfTestSignalInfo | null): string {
  if (info === null) return 'not run'
  const mins = Math.floor(info.ageMs / 60000)
  const age = mins <= 0 ? 'just now' : `${mins}m ago`
  const label = info.result === 'confirmed' ? 'passed' : info.result
  return info.stale ? `${label} ${age} (stale)` : `${label} ${age}`
}

/** The full detail panel's inner HTML — the unchanged v1.3.3 plain-language copy. */
function panelHtml(a: Availability): string {
  const signal = (id: string, label: string, value: string, on: boolean): string =>
    `<div class="alg-ind__signal" data-signal="${id}">` +
    `<span class="alg-ind__label">${label}</span>` +
    `<span class="alg-ind__value ${on ? 'alg-ind__value--on' : 'alg-ind__value--off'}">${value}</span>` +
    `</div>`

  return (
    `<div class="alg-ind__header"><span class="alg-ind__pdot"></span>AI Leak Guard is on here</div>` +
    `<div class="alg-ind__sub">What it's checking on this page</div>` +
    `<div class="alg-ind__signals">` +
    signal('active', 'Active on this page', a.composerPresent ? 'Yes' : 'No', a.composerPresent) +
    signal('paste', 'Paste', signalValue(a.paste), a.paste === 'ready') +
    signal('send', 'Before you send', signalValue(a.send), a.send === 'ready') +
    signal('file', 'Attached files', signalValue(a.fileScanning), a.fileScanning === 'ready') +
    signal(
      'selftest',
      'Last check',
      selfTestValue(a.lastSelfTest),
      a.lastSelfTest?.result === 'confirmed' && a.lastSelfTest.stale === false,
    ) +
    `</div>` +
    `<div class="alg-ind__note">Sites change often — tap Test protection to confirm it's working here.</div>`
  )
}

/** Create the chip indicator. Collapsed to a chip by default; expands on hover /
 *  focus / tap into the full detail panel. */
export function createAvailabilityIndicator(
  deps: AvailabilityIndicatorDeps,
): AvailabilityIndicator {
  let host: HTMLElement | null = null
  let root: HTMLElement | null = null // the `.alg-ind` wrapper inside the shadow
  let chip: HTMLElement | null = null
  let panel: HTMLElement | null = null
  let expanded = false
  let dismissed = false

  const removeHost = (): void => {
    host?.remove()
    host = null
    root = null
    chip = null
    panel = null
    expanded = false
  }

  const syncPanel = (a: Availability): void => {
    if (root === null) return
    if (expanded) {
      if (panel === null) {
        panel = document.createElement('div')
        panel.className = 'alg-ind__panel'
        // The panel is informational; it is not itself a focus target.
        root.insertBefore(panel, root.firstChild)
      }
      panel.innerHTML = panelHtml(a)
    } else if (panel !== null) {
      panel.remove()
      panel = null
    }
    chip?.setAttribute('aria-expanded', expanded ? 'true' : 'false')
  }

  const setExpanded = (next: boolean): void => {
    if (expanded === next) return
    expanded = next
    const a = safeAvailability()
    if (a === null || !a.activeHere) {
      // If the surface just went inactive, the next refresh removes the host;
      // don't render a panel over nothing.
      return
    }
    syncPanel(a)
  }

  const safeAvailability = (): Availability | null => {
    try {
      return deps.getAvailability()
    } catch {
      return null
    }
  }

  const dismiss = (): void => {
    dismissed = true
    try {
      deps.onDismiss?.()
    } catch {
      // best-effort; the local flag still hides it for this page.
    }
    removeHost()
  }

  const build = (): void => {
    const mountPoint = (deps.mount?.() ?? document.body) as ParentNode | null
    if (mountPoint === null) return
    host = document.createElement('div')
    host.setAttribute(HOST_ATTR, '')
    // Open shadow: the content is non-sensitive availability labels (no user
    // data), and an open root lets the page-agnostic styles apply and keeps the
    // pill inspectable. Distinct host from the (closed) warning modals.
    host.attachShadow({ mode: 'open' })
    const shadow = host.shadowRoot
    if (shadow === null) {
      host = null
      return
    }

    root = document.createElement('div')
    root.className = 'alg-ind'
    // `role="status"`/`aria-live="off"` keeps sensible semantics without
    // announcing on load (it never steals or traps focus).
    root.setAttribute('role', 'status')
    root.setAttribute('aria-live', 'off')

    chip = document.createElement('div')
    chip.className = 'alg-ind__chip'
    chip.setAttribute('data-chip', '')
    chip.setAttribute('role', 'button')
    chip.setAttribute('tabindex', '0')
    chip.setAttribute('aria-expanded', 'false')
    chip.setAttribute('aria-label', 'AI Leak Guard — show what it is checking on this page')
    chip.innerHTML =
      `<span class="alg-ind__dot"></span>` +
      `<span class="alg-ind__chip-label">AI Leak Guard</span>` +
      `<button type="button" class="alg-ind__dismiss" data-dismiss aria-label="Hide AI Leak Guard here">&times;</button>`

    root.appendChild(chip)
    shadow.appendChild(document.createElement('style')).textContent = STYLE
    shadow.appendChild(root)
    ;(mountPoint as ParentNode & { appendChild: (n: Node) => void }).appendChild(host)

    // Expand on hover / focus of anywhere in the pill; collapse on leave / blur.
    // Listening on the wrapper means moving the pointer chip → panel does not
    // collapse it.
    root.addEventListener('mouseenter', () => setExpanded(true))
    root.addEventListener('mouseleave', () => setExpanded(false))
    root.addEventListener('focusin', () => setExpanded(true))
    root.addEventListener('focusout', () => {
      // Defer so focus moving between the chip and its "×" does not collapse.
      setTimeout(() => {
        if (!host?.shadowRoot?.activeElement) setExpanded(false)
      }, 0)
    })

    const toggle = (): void => setExpanded(!expanded)
    chip.addEventListener('click', (e) => {
      // A click on the "×" is a dismiss, never a toggle.
      if ((e.target as HTMLElement | null)?.closest('[data-dismiss]') !== null) return
      toggle()
    })
    chip.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
        if ((e.target as HTMLElement | null)?.closest('[data-dismiss]') !== null) return
        e.preventDefault()
        toggle()
      }
    })

    const dismissBtn = chip.querySelector('[data-dismiss]')
    dismissBtn?.addEventListener('click', (e) => {
      e.stopPropagation()
      dismiss()
    })
    dismissBtn?.addEventListener('keydown', (e) => {
      const ke = e as KeyboardEvent
      if (ke.key === 'Enter' || ke.key === ' ' || ke.key === 'Spacebar') {
        e.preventDefault()
        e.stopPropagation()
        dismiss()
      }
    })
  }

  const isDismissed = (): boolean => {
    if (dismissed) return true
    try {
      return deps.isDismissed?.() === true
    } catch {
      return false
    }
  }

  const refresh = (): void => {
    // Dismissed for this origin → never render (and drop any existing host).
    if (isDismissed()) {
      removeHost()
      return
    }
    const a = safeAvailability()
    // Render ONLY when active here. Not active (no composer / disabled / not a
    // covered surface) → remove the host so it never reads ready. This is the
    // anti-stale-green guarantee.
    if (a === null || !a.activeHere) {
      removeHost()
      return
    }
    if (host === null) build()
    if (host === null) return // mount not ready yet
    // Keep an open panel's values fresh without rebuilding the chip (so a
    // periodic refresh never collapses it or drops focus).
    if (expanded) syncPanel(a)
  }

  return { refresh, destroy: removeHost }
}

export { HOST_ATTR as AVAILABILITY_HOST_ATTR }
