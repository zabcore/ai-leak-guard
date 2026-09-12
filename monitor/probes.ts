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

/**
 * Dismiss whichever guard modal is open (Escape → cancel) and wait until
 * neither host remains. The readiness gate reuses the SAME page for the
 * real probe, so a modal left behind here would let a later probe report
 * `modalAppeared: true` without mounting a new one — the wait therefore
 * throws on timeout rather than swallowing it.
 */
export async function closeAnyModal(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    )
  })
  await page.waitForFunction(
    (hosts) =>
      !document.querySelector(`[${hosts.paste}]`) && !document.querySelector(`[${hosts.document}]`),
    MODAL_HOST,
    { timeout: 3000 },
  )
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
