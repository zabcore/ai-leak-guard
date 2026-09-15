// V1.3.1 §C monitor — the route drivers.
//
// Each probe dispatches the SYNTHETIC DOM event the shipped adapter
// listens for (capture-phase on window; it never checks isTrusted on the
// intercept path, so a dispatched event is a faithful stand-in for the
// user's gesture) and reports two content-free signals:
//   • intercepted   — the event's defaultPrevented, i.e. the extension's
//                     capture-phase listener called preventDefault. This
//                     is the synchronous, unambiguous "the extension took
//                     this gesture" signal.
//   • modalAppeared — the extension mounted its warning modal host in the
//                     light DOM (the user actually saw a warning).
//
// A route the extension protects yields intercepted && modalAppeared; a
// route it (correctly) stays out of yields neither.

import type { Page } from '@playwright/test'
import { HOOK, MODAL_HOST, SENSITIVE_TEXT, SENSITIVE_FILE } from './surfaces'

export interface ProbeResult {
  readonly intercepted: boolean
  readonly modalAppeared: boolean
}

/** Wait (bounded) for a modal host to attach; returns whether it did. */
async function hostAppears(page: Page, attr: string, timeoutMs: number): Promise<boolean> {
  const handle = await page
    .waitForSelector(`[${attr}]`, { state: 'attached', timeout: timeoutMs })
    .catch(() => null)
  return handle !== null
}

/** True once neither modal host is present (used after closing one). */
async function noModalHost(page: Page): Promise<boolean> {
  return page.evaluate(
    (hosts) =>
      !document.querySelector(`[${hosts.paste}]`) && !document.querySelector(`[${hosts.document}]`),
    MODAL_HOST,
  )
}

/** Dismiss whichever guard modal is open (Escape → cancel) and settle. */
export async function closeAnyModal(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    )
  })
  await page
    .waitForFunction(
      (hosts) =>
        !document.querySelector(`[${hosts.paste}]`) &&
        !document.querySelector(`[${hosts.document}]`),
      MODAL_HOST,
      { timeout: 3000 },
    )
    .catch(() => {
      /* best-effort; a fresh page is used per probe anyway */
    })
}

/** Dispatch a synthetic sensitive paste on the composer; return defaultPrevented. */
async function dispatchPaste(page: Page): Promise<boolean> {
  return page.evaluate(
    ([sel, text]) => {
      const el = document.querySelector(sel)
      if (el === null) return false
      ;(el as HTMLElement).focus()
      const dt = new DataTransfer()
      dt.setData('text/plain', text)
      const ev = new ClipboardEvent('paste', {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
      })
      el.dispatchEvent(ev)
      return ev.defaultPrevented
    },
    [HOOK.composer, SENSITIVE_TEXT] as const,
  )
}

/**
 * Confirm the packaged extension is attached and live on THIS page before
 * trusting any probe result (especially a negative one). Every fixture's
 * surface supports paste, so a sensitive paste MUST be intercepted once
 * the content script has loaded; we retry until it is, then dismiss the
 * preview modal so the page is clean for the real probe. Throws if the
 * extension never intercepts — an environment/build blocker, not a
 * per-route regression.
 */
export async function ensureExtensionReady(page: Page, attempts = 30, gapMs = 200): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    if (await dispatchPaste(page)) {
      await closeAnyModal(page)
      return
    }
    await page.waitForTimeout(gapMs)
  }
  throw new Error(
    'Extension never intercepted a sensitive paste on this page — the packaged content script did not attach, or the paste adapter no longer matches the composer.',
  )
}

export async function probePaste(page: Page): Promise<ProbeResult> {
  const intercepted = await dispatchPaste(page)
  const modalAppeared = await hostAppears(page, MODAL_HOST.paste, intercepted ? 3000 : 1200)
  return { intercepted, modalAppeared }
}

/** Put sensitive text in the composer (textarea value OR contenteditable). */
async function primeComposer(page: Page): Promise<void> {
  await page.evaluate(
    ([sel, text]) => {
      const el = document.querySelector(sel)
      if (el === null) return
      if (el.tagName === 'TEXTAREA') {
        ;(el as HTMLTextAreaElement).value = text
      } else {
        el.innerHTML = `<p>${text}</p>`
      }
      ;(el as HTMLElement).focus()
    },
    [HOOK.composer, SENSITIVE_TEXT] as const,
  )
}

export async function probeSendEnter(page: Page): Promise<ProbeResult> {
  await primeComposer(page)
  const intercepted = await page.evaluate((sel) => {
    const el = document.querySelector(sel)
    if (el === null) return false
    const ev = new KeyboardEvent('keydown', {
      key: 'Enter',
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true,
      composed: true,
    })
    el.dispatchEvent(ev)
    return ev.defaultPrevented
  }, HOOK.composer)
  const modalAppeared = await hostAppears(page, MODAL_HOST.document, intercepted ? 4000 : 1200)
  return { intercepted, modalAppeared }
}

export async function probeSendButton(page: Page): Promise<ProbeResult> {
  await primeComposer(page)
  const intercepted = await page.evaluate((sel) => {
    const btn = document.querySelector(sel)
    if (btn === null) return false
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true, composed: true })
    btn.dispatchEvent(ev)
    return ev.defaultPrevented
  }, HOOK.send)
  const modalAppeared = await hostAppears(page, MODAL_HOST.document, intercepted ? 4000 : 1200)
  return { intercepted, modalAppeared }
}

export async function probeDocument(page: Page): Promise<ProbeResult> {
  const intercepted = await page.evaluate(
    ([sel, file]) => {
      const input = document.querySelector(sel) as HTMLInputElement | null
      if (input === null) return false
      const dt = new DataTransfer()
      dt.items.add(new File([file.body], file.name, { type: file.type }))
      input.files = dt.files
      // change events aren't cancelable in the wild; we make this synthetic
      // one cancelable so the extension's preventDefault is observable.
      const ev = new Event('change', { bubbles: true, cancelable: true })
      input.dispatchEvent(ev)
      return ev.defaultPrevented
    },
    [HOOK.file, SENSITIVE_FILE] as const,
  )
  // The document modal opens only after inspection settles (sensitive
  // view), so allow a longer window on the positive path.
  const modalAppeared = await hostAppears(page, MODAL_HOST.document, intercepted ? 6000 : 1500)
  return { intercepted, modalAppeared }
}

/** Confirm no modal is left on screen (post-probe hygiene helper). */
export async function assertClean(page: Page): Promise<boolean> {
  return noModalHost(page)
}

// ── live-noauth drift probe ────────────────────────────────────────────────
//
// Runs against the REAL logged-out site (no fixture, no login). It catches the
// site drifting under us — the extension appearing installed while silently
// not recognising a composer. Every non-PASS is a red run; the classification
// lets triage separate a real product regression from an environment problem.

/**
 * PASS           — the composer was found AND the extension mounted its modal.
 * PRODUCT_FAILURE — the composer was found but NO modal mounted (drift: the
 *                   adapter no longer recognises this surface). This is the
 *                   leak we ship.
 * ENV_AUTH_FAILURE — no composer ever appeared (page didn't load, CAPTCHA,
 *                   interstitial, or a login wall). Still red, but not a
 *                   product regression — triage differs.
 */
export type LiveNoauthResult = 'PASS' | 'PRODUCT_FAILURE' | 'ENV_AUTH_FAILURE'

export interface LiveNoauthOutcome {
  readonly result: LiveNoauthResult
  readonly detail: string
}

/** Poll for any of the selectors to attach; return the first that matched. */
async function firstPresentSelector(
  page: Page,
  selectors: readonly string[],
  timeoutMs: number,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs
  do {
    for (const sel of selectors) {
      const handle = await page.$(sel).catch(() => null)
      if (handle !== null) return sel
    }
    await page.waitForTimeout(300)
  } while (Date.now() < deadline)
  return null
}

/**
 * Drive the real logged-out composer and assert the extension warns. The page
 * must already be navigated (see `openLiveNoauthPage`). Never throws on a site
 * problem — it classifies instead, so the caller asserts on `result === 'PASS'`
 * and any other value fails the test with a triage-ready message.
 */
export async function probeLiveNoauth(
  page: Page,
  selectors: readonly string[],
): Promise<LiveNoauthOutcome> {
  const sel = await firstPresentSelector(page, selectors, 15_000)
  if (sel === null) {
    return {
      result: 'ENV_AUTH_FAILURE',
      detail:
        'no composer appeared within 15s — page did not load / CAPTCHA / interstitial / login wall',
    }
  }

  // Type through the real DOM, then trigger the paste path the extension hooks.
  await page.evaluate(
    ([s, text]) => {
      const el = document.querySelector(s)
      if (el === null) return
      ;(el as HTMLElement).focus()
      if (el.tagName === 'TEXTAREA') (el as HTMLTextAreaElement).value = text
      const dt = new DataTransfer()
      dt.setData('text/plain', text)
      el.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }),
      )
    },
    [sel, SENSITIVE_TEXT] as const,
  )

  const mounted = await hostAppears(page, MODAL_HOST.paste, 5_000)
  if (mounted) {
    return { result: 'PASS', detail: `composer "${sel}" recognised; modal host mounted` }
  }
  return {
    result: 'PRODUCT_FAILURE',
    detail: `composer "${sel}" is present but the extension mounted no modal host — the surface drifted (silent leak)`,
  }
}
