// @vitest-environment jsdom
//
// V1.3.3 gap 2 — the self-test must NEVER erase user work. Every exit path
// (success/auto-cancel, unsupported, timeout, and page navigation/unload)
// clears the composer ONLY when it still holds exactly the synthetic text we
// injected; if the user typed during the run, their text is preserved.

import { describe, expect, it } from 'vitest'
import {
  runSelfTest,
  guardedClear,
  installUnloadGuard,
  type SelfTestRunnerDeps,
} from '../src/content/submit/self-test'

type EditPoint = 'none' | 'unsupported' | 'timeout' | 'cancel'

/** A runner harness whose composer text can be edited mid-run at a chosen point. */
function harness(editAt: EditPoint) {
  const el = document.createElement('div')
  let text = ''
  let modalOpen = false
  const calls = { cleared: 0, cancelled: 0, inserts: [] as string[] }
  const USER_EDIT = 'a real question the user started typing'

  const deps: SelfTestRunnerDeps = {
    getComposer: () => el,
    readText: () => text,
    insert: (_e, t) => {
      calls.inserts.push(t)
      text = t
    },
    clear: () => {
      calls.cleared += 1
      text = ''
    },
    dispatchSend: () => {
      if (editAt === 'unsupported') {
        text = USER_EDIT // user typed just as the (failing) send fired
        return false
      }
      // 'timeout' leaves the modal closed so the modal-wait poll times out
      // (NO_MODAL); every other case opens it.
      if (editAt !== 'timeout') modalOpen = true
      return true
    },
    isModalOpen: () => modalOpen,
    cancelModal: () => {
      calls.cancelled += 1
      modalOpen = false
      if (editAt === 'cancel') text = USER_EDIT // user typed during the modal
    },
    now: () => Date.now(),
    sleep: async () => {
      if (editAt === 'timeout') text = USER_EDIT // user typed during the wait
    },
    composerTimeoutMs: 50,
    modalTimeoutMs: 50,
    pollMs: 1,
  }

  return { deps, el, calls, getText: () => text, USER_EDIT }
}

describe('self-test edit-guard — never erases user work', () => {
  it('success/auto-cancel: user types during the run → text preserved, not cleared', async () => {
    const h = harness('cancel')
    const report = await runSelfTest(h.deps)
    expect(report.result).toBe('confirmed')
    expect(h.calls.cleared).toBe(0) // never wiped the user's text
    expect(h.getText()).toBe(h.USER_EDIT)
  })

  it('unsupported (NO_INTERCEPT): user text present at cleanup → preserved', async () => {
    const h = harness('unsupported')
    const report = await runSelfTest(h.deps)
    expect(report.code).toBe('NO_INTERCEPT')
    expect(h.calls.cleared).toBe(0)
    expect(h.getText()).toBe(h.USER_EDIT)
  })

  it('timeout (NO_MODAL): user types during the wait → preserved', async () => {
    const h = harness('timeout')
    const report = await runSelfTest(h.deps)
    expect(report.code).toBe('NO_MODAL')
    expect(h.calls.cleared).toBe(0)
    expect(h.getText()).toBe(h.USER_EDIT)
  })

  it('clean run (no edit): synthetic text IS cleared on every case', async () => {
    const h = harness('none')
    const report = await runSelfTest(h.deps)
    expect(report.result).toBe('confirmed')
    expect(h.calls.cleared).toBeGreaterThanOrEqual(1)
    expect(h.getText()).toBe('')
  })

  it('navigation/unload: pagehide clears synthetic text but preserves a user edit', () => {
    const readText = (el: HTMLElement) => el.textContent ?? ''
    const clear = (el: HTMLElement) => {
      el.textContent = ''
    }

    // (a) synthetic still present → unload guard clears it.
    const synthetic = document.createElement('div')
    synthetic.textContent = 'MRN 12345678'
    const removeA = installUnloadGuard(
      window,
      () => ({ el: synthetic, injected: 'MRN 12345678' }),
      { readText, clear },
    )
    window.dispatchEvent(new Event('pagehide'))
    expect(synthetic.textContent).toBe('')
    removeA()

    // (b) user edited → unload guard leaves it untouched.
    const edited = document.createElement('div')
    edited.textContent = 'the user replaced it with a real question'
    const removeB = installUnloadGuard(window, () => ({ el: edited, injected: 'MRN 12345678' }), {
      readText,
      clear,
    })
    window.dispatchEvent(new Event('pagehide'))
    expect(edited.textContent).toBe('the user replaced it with a real question')
    removeB()

    // (c) the guard is removed → no further clearing.
    const after = document.createElement('div')
    after.textContent = 'MRN 12345678'
    const removeC = installUnloadGuard(window, () => ({ el: after, injected: 'MRN 12345678' }), {
      readText,
      clear,
    })
    removeC()
    window.dispatchEvent(new Event('pagehide'))
    expect(after.textContent).toBe('MRN 12345678')
  })

  it('guardedClear: clears on exact match, preserves on any difference', () => {
    const el = document.createElement('div')
    const ops = {
      readText: (e: HTMLElement) => e.textContent ?? '',
      clear: (e: HTMLElement) => {
        e.textContent = ''
      },
    }
    el.textContent = 'MRN 12345678'
    expect(guardedClear(el, 'MRN 12345678', ops)).toBe(true)
    expect(el.textContent).toBe('')

    el.textContent = 'MRN 12345678 and my own note'
    expect(guardedClear(el, 'MRN 12345678', ops)).toBe(false)
    expect(el.textContent).toBe('MRN 12345678 and my own note')
  })
})
