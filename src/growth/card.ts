// V1.3.1 §Growth Loop — the review/referral card (DOM) + wiring.
//
// This is the only growth module that touches the DOM, so it is imported ONLY
// by the popup and the activity page (never the service worker). Rendering is
// `textContent`-only and the card shows NO event counts. Both CTAs are
// user-initiated (a tab open via `chrome.tabs.create`, a clipboard copy on the
// click gesture) — the extension issues no network request.

import {
  GROWTH_COPY,
  INSTALL_LINK_URL,
  LINK_COPIED_REVERT_MS,
  STORE_REVIEW_URL,
} from './constants'
import {
  applyDismiss,
  applyReEnable,
  applyReviewClicked,
  applyShareClicked,
  computeEligibility,
  ensureInstallDate,
  markEligible,
  markShown,
} from './eligibility'
import { gatherEligibilityInputs } from './signals'
import { readGrowthState, writeGrowthState } from './store'
import type { GrowthState } from './types'

export interface GrowthCardDeps {
  /** Clock seam (defaults to `Date.now`). */
  readonly now?: () => number
  /** Open a URL in a new tab (defaults to `chrome.tabs.create`). */
  readonly openUrl?: (url: string) => void
  /** Copy text to the clipboard (defaults to `navigator.clipboard.writeText`). */
  readonly copyText?: (text: string) => void
  /**
   * Evaluate the active-tab "current site unsupported" suppression? The popup
   * passes `true`; the activity page passes `false`.
   */
  readonly checkActiveSite: boolean
}

function nowOf(deps: GrowthCardDeps): number {
  return (deps.now ?? Date.now)()
}

function defaultOpenUrl(url: string): void {
  try {
    const tabsApi = (globalThis as unknown as { chrome?: typeof chrome }).chrome?.tabs
    if (tabsApi && typeof tabsApi.create === 'function') {
      void tabsApi.create({ url })
    }
  } catch (err) {
    console.warn('[AI Leak Guard] growth: failed to open tab:', err)
  }
}

function defaultCopyText(text: string): void {
  try {
    void (
      globalThis as unknown as {
        navigator?: { clipboard?: { writeText?: (t: string) => unknown } }
      }
    ).navigator?.clipboard?.writeText?.(text)
  } catch (err) {
    console.warn('[AI Leak Guard] growth: clipboard copy failed:', err)
  }
}

/** Persist a state transition as a read-modify-write (best-effort). */
async function mutate(fn: (prev: GrowthState) => GrowthState): Promise<void> {
  const prev = await readGrowthState()
  await writeGrowthState(fn(prev))
}

/**
 * Build the card element with its buttons wired. Pure DOM construction — no
 * storage reads; callers persist and decide whether to show it.
 */
export function buildGrowthCard(deps: GrowthCardDeps, reviewAlreadyClicked: boolean): HTMLElement {
  const openUrl = deps.openUrl ?? defaultOpenUrl
  const copyText = deps.copyText ?? defaultCopyText

  const card = document.createElement('section')
  card.className = 'growth'
  card.setAttribute('aria-label', GROWTH_COPY.heading)

  const heading = document.createElement('h2')
  heading.className = 'growth__heading'
  heading.textContent = GROWTH_COPY.heading

  const sub = document.createElement('p')
  sub.className = 'growth__sub'
  sub.textContent = GROWTH_COPY.sub

  const actions = document.createElement('div')
  actions.className = 'growth__actions'

  // Review CTA — hidden once the review has been clicked (never nag again).
  const reviewBtn = document.createElement('button')
  reviewBtn.type = 'button'
  reviewBtn.className = 'growth__btn growth__btn--review'
  reviewBtn.textContent = GROWTH_COPY.reviewCta
  reviewBtn.hidden = reviewAlreadyClicked

  const thanks = document.createElement('p')
  thanks.className = 'growth__thanks'
  thanks.textContent = 'Thanks — that really helps.'
  thanks.hidden = !reviewAlreadyClicked

  reviewBtn.addEventListener('click', () => {
    openUrl(STORE_REVIEW_URL)
    reviewBtn.hidden = true
    thanks.hidden = false
    void mutate((prev) => applyReviewClicked(prev))
  })

  // Referral CTA — copy the install link on the click gesture.
  const shareBtn = document.createElement('button')
  shareBtn.type = 'button'
  shareBtn.className = 'growth__btn growth__btn--share'
  shareBtn.textContent = GROWTH_COPY.shareCta
  let revertTimer: ReturnType<typeof setTimeout> | null = null
  shareBtn.addEventListener('click', () => {
    copyText(INSTALL_LINK_URL)
    shareBtn.textContent = GROWTH_COPY.linkCopied
    if (revertTimer !== null) clearTimeout(revertTimer)
    revertTimer = setTimeout(() => {
      shareBtn.textContent = GROWTH_COPY.shareCta
    }, LINK_COPIED_REVERT_MS)
    void mutate((prev) => applyShareClicked(prev))
  })

  // Dismissal — "Not now".
  const dismissBtn = document.createElement('button')
  dismissBtn.type = 'button'
  dismissBtn.className = 'growth__btn growth__btn--dismiss'
  dismissBtn.textContent = GROWTH_COPY.dismissCta
  dismissBtn.addEventListener('click', () => {
    const now = nowOf(deps)
    void mutate((prev) => applyDismiss(prev, now))
    card.remove()
  })

  actions.append(reviewBtn, shareBtn, dismissBtn)
  card.append(heading, sub, thanks, actions)
  return card
}

/** Remove any card already mounted in this container (single instance). */
function clearExisting(container: HTMLElement): void {
  container.querySelectorAll('.growth').forEach((n) => n.remove())
}

/**
 * Mount the card automatically IF eligible. Sets `installDate` on first open,
 * records first-eligible + last-shown, and persists. Returns whether the card
 * was shown. Best-effort — a failure logs and shows nothing.
 */
export async function mountGrowthPrompt(
  container: HTMLElement,
  deps: GrowthCardDeps,
): Promise<boolean> {
  try {
    const now = nowOf(deps)
    let state = ensureInstallDate(await readGrowthState(), now)
    // Persist the install date immediately so the 3-day clock starts on the
    // very first popup open even if the user never returns this session.
    await writeGrowthState(state)

    const inputs = await gatherEligibilityInputs(state, {
      now,
      checkActiveSite: deps.checkActiveSite,
    })
    const decision = computeEligibility(inputs)
    if (!decision.eligible) return false

    state = markShown(markEligible(state, now), now)
    await writeGrowthState(state)

    clearExisting(container)
    container.appendChild(buildGrowthCard(deps, state.reviewClicked))
    container.hidden = false
    return true
  } catch (err) {
    console.warn('[AI Leak Guard] growth: mount failed:', err)
    return false
  }
}

/**
 * Wire the always-present "Support AI Leak Guard" link (settings/help). On
 * click it re-enables a permanently-suppressed prompt and shows the card
 * immediately — an explicit, user-initiated reveal that bypasses the timing
 * gates (the user is asking to support the product). Failure-suppression is
 * moot here: the card only offers a review and a share link.
 */
export function wireSupportLink(
  link: HTMLElement,
  container: HTMLElement,
  deps: GrowthCardDeps,
): void {
  link.addEventListener('click', (e) => {
    e.preventDefault()
    void (async () => {
      try {
        const now = nowOf(deps)
        const state = markShown(applyReEnable(ensureInstallDate(await readGrowthState(), now)), now)
        await writeGrowthState(state)
        clearExisting(container)
        container.hidden = false
        container.appendChild(buildGrowthCard(deps, state.reviewClicked))
        container.scrollIntoView({ block: 'nearest' })
      } catch (err) {
        console.warn('[AI Leak Guard] growth: support-link reveal failed:', err)
      }
    })()
  })
}
