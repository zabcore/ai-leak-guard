// @vitest-environment jsdom
//
// V1.3 M6 — regression-matrix gap-fillers (brief §9). Most §9 rows are
// already covered by the M1–M5 suites (see docs/REGRESSION_MATRIX.md for
// the full mapping). This file ADDS the rows that had no explicit test,
// exercised through the REAL adapters + core across all three sites:
//
//   • injected / autocompleted text (programmatic set) → detected at send
//   • simulated dictation (programmatic value set)     → detected at send
//   • paste-then-type-more → combined text scanned at send
//   • Ctrl/Cmd+Enter → intercepted per the M0 binding
//   • suggestion-chip programmatic click → NOT intercepted (documented GAP)
//   • composer re-renders between hold and resume → still resolves
//
// Plus an explicit "document-gate holds no content/filenames" negative
// test (the gate is metadata-only by construction; this pins it).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatGptSubmitAdapter } from '../src/content/submit/adapters/chatgpt'
import { ClaudeSubmitAdapter } from '../src/content/submit/adapters/claude'
import { GeminiSubmitAdapter } from '../src/content/submit/adapters/gemini'
import type { BaseSubmitAdapter } from '../src/content/submit/adapters/base-submit-adapter'
import { detectDetailed } from '../src/detector/engine'
import { __resetDocumentModalForTests } from '../src/content/document-modal'
import { settleDoc, getDoc, __resetDocumentGateForTests } from '../src/content/submit/document-gate'
import { DetectorCategory } from '../src/detector/types'
import {
  makeCore,
  controllableDecide,
  pressEnter,
  flush,
  SSN_TEXT,
} from './helpers/submit-adapter-harness'

interface SiteRig {
  readonly id: string
  build(): { composer: HTMLElement; button: HTMLButtonElement }
  make(opts?: ConstructorParameters<typeof ChatGptSubmitAdapter>[0]): BaseSubmitAdapter
}

function el(tag: string, attrs: Record<string, string>, html = ''): HTMLElement {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v)
  if (html) node.innerHTML = html
  return node
}

const SITES: readonly SiteRig[] = [
  {
    id: 'chatgpt',
    build() {
      const composer = el(
        'div',
        { id: 'prompt-textarea', contenteditable: 'true', role: 'textbox' },
        '<p></p>',
      )
      const button = el('button', {
        'data-testid': 'send-button',
        'aria-label': 'Send prompt',
      }) as HTMLButtonElement
      document.body.append(composer, button)
      return { composer, button }
    },
    make: (opts) => new ChatGptSubmitAdapter(opts),
  },
  {
    id: 'claude',
    build() {
      const composer = el('div', { contenteditable: 'true', role: 'textbox' }, '<p></p>')
      const button = el('button', {
        'data-testid': 'chat-input-send',
        'aria-label': 'Send message',
      }) as HTMLButtonElement
      document.body.append(composer, button)
      return { composer, button }
    },
    make: (opts) => new ClaudeSubmitAdapter(opts),
  },
  {
    id: 'gemini',
    build() {
      const host = el('rich-textarea', {})
      const composer = el('div', { contenteditable: 'true', role: 'textbox' }, '<p></p>')
      host.appendChild(composer)
      const wrapper = el('gem-icon-button', { class: 'send-button submit' })
      const button = el('button', { 'aria-label': 'Send message' }) as HTMLButtonElement
      wrapper.appendChild(button)
      document.body.append(host, wrapper)
      return { composer, button }
    },
    make: (opts) => new GeminiSubmitAdapter(opts),
  },
]

let adapter: BaseSubmitAdapter | null = null

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  adapter?.detach()
  adapter = null
  document.body.innerHTML = ''
  __resetDocumentModalForTests()
  __resetDocumentGateForTests()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

for (const site of SITES) {
  describe(`§9 gap-fillers — ${site.id}`, () => {
    it('injected / autocompleted text (programmatic set, no input event) → detected at send', async () => {
      const { composer } = site.build()
      // Simulate an autocomplete/extension injecting text directly — no
      // `input`/`beforeinput` event fired. The send-scan reads the
      // composer AT SEND, so it does not depend on input events.
      composer.innerHTML = `<p>${SSN_TEXT}</p>`
      const scan = vi.fn((t: string) => detectDetailed(t))
      const decide = controllableDecide()
      adapter = site.make()
      adapter.attach(makeCore({ scan, decide: decide.decide }))
      const event = pressEnter(composer)
      expect(event.defaultPrevented).toBe(true)
      await flush()
      expect(scan).toHaveBeenCalledTimes(1)
      expect(scan.mock.calls[0][0]).toContain('123-45-6789')
      expect(decide.calls).toBe(1) // modal opened
      decide.resolve('return-to-edit')
      await flush()
    })

    it('simulated dictation (programmatic value set) → detected at send', async () => {
      const { composer } = site.build()
      // Dictation appends text programmatically over time; the final
      // composer state is what the send-scan reads.
      composer.innerHTML = '<p>Patient</p>'
      composer.innerHTML = `<p>Patient ${SSN_TEXT}</p>`
      const scan = vi.fn((t: string) => detectDetailed(t))
      const decide = controllableDecide()
      adapter = site.make()
      adapter.attach(makeCore({ scan, decide: decide.decide }))
      pressEnter(composer)
      await flush()
      expect(scan.mock.calls[0][0]).toContain('123-45-6789')
      expect(decide.calls).toBe(1)
      decide.resolve('return-to-edit')
      await flush()
    })

    it('paste-then-type-more → the COMBINED composer text is scanned at send', async () => {
      const { composer } = site.build()
      // A pasted SSN, then the user typed more after it. At send the
      // whole composer is scanned — the SSN is still caught.
      composer.innerHTML = `<p>${SSN_TEXT}</p><p>and please summarise the plan</p>`
      const scan = vi.fn((t: string) => detectDetailed(t))
      const decide = controllableDecide()
      adapter = site.make()
      adapter.attach(makeCore({ scan, decide: decide.decide }))
      pressEnter(composer)
      await flush()
      const scanned = scan.mock.calls[0][0]
      expect(scanned).toContain('123-45-6789')
      expect(scanned).toContain('summarise the plan')
      decide.resolve('return-to-edit')
      await flush()
    })

    it('Ctrl+Enter and Cmd+Enter → intercepted per the M0 binding (send intent)', async () => {
      const { composer } = site.build()
      composer.innerHTML = `<p>${SSN_TEXT}</p>`
      const scan = vi.fn((t: string) => detectDetailed(t))
      const decide = controllableDecide()
      adapter = site.make()
      adapter.attach(makeCore({ scan, decide: decide.decide }))
      const ctrl = pressEnter(composer, { ctrlKey: true })
      expect(ctrl.defaultPrevented).toBe(true)
      await flush()
      expect(scan).toHaveBeenCalledTimes(1)
      decide.resolve('return-to-edit')
      await flush()
      // Cmd+Enter (metaKey) — same binding.
      scan.mockClear()
      const meta = pressEnter(composer, { metaKey: true })
      expect(meta.defaultPrevented).toBe(true)
      await flush()
      expect(scan).toHaveBeenCalledTimes(1)
      decide.resolve('return-to-edit')
      await flush()
    })

    it('DOCUMENTED GAP: a programmatic suggestion-chip click is NOT intercepted', async () => {
      const { composer } = site.build()
      composer.innerHTML = `<p>${SSN_TEXT}</p>`
      // A "suggestion chip" is an ordinary button that is NOT the send
      // button. Clicking it (even programmatically) must NOT be taken as
      // a send — the adapter only intercepts the composer's Enter and
      // the site's send button. This pins the Q7 coverage gap so the
      // matrix never claims chips are caught.
      const chip = el('button', { class: 'suggestion-chip' }) as HTMLButtonElement
      document.body.appendChild(chip)
      const scan = vi.fn((t: string) => detectDetailed(t))
      adapter = site.make()
      adapter.attach(makeCore({ scan }))
      const event = new MouseEvent('click', { bubbles: true, cancelable: true, composed: true })
      chip.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(false)
      await flush()
      expect(scan).not.toHaveBeenCalled()
    })

    it('composer re-renders between hold and resume → resume still resolves and submits once', async () => {
      const rig = site.build()
      rig.composer.innerHTML = `<p>${SSN_TEXT}</p>`
      let clicks = 0
      const attachClick = (btn: HTMLButtonElement): void => {
        btn.addEventListener('click', () => {
          clicks += 1
        })
      }
      attachClick(rig.button)
      const decide = controllableDecide()
      adapter = site.make()
      adapter.attach(makeCore({ decide: decide.decide }))
      pressEnter(rig.composer)
      await flush()
      expect(decide.calls).toBe(1)
      // The site re-renders the composer + button (React/Angular churn)
      // BEFORE the user proceeds: swap in fresh nodes matching the same
      // selectors. Resume must re-resolve them, not cling to detached ones.
      document.body.innerHTML = ''
      const fresh = site.build()
      fresh.composer.innerHTML = `<p>${SSN_TEXT}</p>`
      attachClick(fresh.button)
      fresh.button.addEventListener('click', () => {
        fresh.composer.innerHTML = '<p></p>'
      })
      decide.resolve('proceed')
      await flush()
      expect(clicks).toBe(1) // resumed against the fresh button, exactly once
    })
  })
}

describe('§8 — document-gate holds NO content or filenames', () => {
  it('a settled snapshot carries only metadata fields (categories/count/severity/fileCount)', () => {
    // Even if a caller tried to smuggle content/filename fields, the gate
    // stores only the typed metadata — the snapshot never exposes them.
    // Content/name fields are not part of the type; cast so we can prove
    // they don't survive into the stored snapshot.
    settleDoc('chatgpt-composer', {
      status: 'detected',
      summary: {
        categories: [DetectorCategory.HEALTHCARE_PATIENT_ID],
        count: 2,
        hasCriticalOrHigh: true,
      },
      fileCount: 1,
      filename: 'discharge-summary.pdf',
      text: 'Patient SSN 123-45-6789',
    } as unknown as Parameters<typeof settleDoc>[1])
    const snap = getDoc('chatgpt-composer')
    const snapKeys = Object.keys(snap).sort()
    expect(snapKeys).toEqual(['acknowledged', 'fileCount', 'status', 'summary'])
    expect(Object.keys(snap.summary ?? {}).sort()).toEqual([
      'categories',
      'count',
      'hasCriticalOrHigh',
    ])
    // Belt-and-braces: no filename / raw text anywhere in the snapshot.
    const serialized = JSON.stringify(snap)
    expect(serialized).not.toContain('discharge-summary')
    expect(serialized).not.toContain('123-45-6789')
  })
})
