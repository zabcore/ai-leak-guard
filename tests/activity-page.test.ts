// @vitest-environment jsdom
//
// V1.2 A5.1 full activity page render test.
//
// Exercises the metadata-only render loop:
//   • empty state on a fresh install;
//   • rendering a fabricated event set, newest-first, with all
//     six columns (timestamp / site / type / action / categories
//     / count);
//   • friendly category chip labels (matches the A4 modal copy);
//   • ring-buffer max render (MAX_EVENTS = 200);
//   • hostile-value absence — a known SSN literal and a filename
//     that "shouldn't" leak MUST NOT appear anywhere in the DOM.
//
// Import the module for its side-effect + call the exported
// __renderForTests seam directly so the assertions run after the
// DOM writes settle. The auto-invoked DOMContentLoaded render is
// exercised implicitly on module load.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { DetectorCategory } from '../src/detector/types'
import { appendEvent, MAX_EVENTS, type AlgEvent } from '../src/shared/event-log'
import { CATEGORY_LABELS } from '../src/popup/labels'

async function loadActivityPage(): Promise<{ render: () => Promise<void> }> {
  const html = readFileSync(resolve('src/popup/activity.html'), 'utf8')
  const body = html.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? html
  document.body.innerHTML = body
  const mod = await import('../src/popup/activity')
  return { render: mod.__renderForTests }
}

function evt(overrides: Partial<AlgEvent> = {}): AlgEvent {
  return {
    ts: Date.now() - 60_000,
    site: 'chatgpt',
    eventType: 'paste',
    action: 'protected',
    categories: [DetectorCategory.HEALTHCARE_PATIENT_ID],
    count: 3,
    hadCriticalOrHigh: true,
    ...overrides,
  }
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('activity page (A5.1)', () => {
  it('renders the empty state when the log is empty', async () => {
    const { render } = await loadActivityPage()
    await render()
    const empty = document.getElementById('empty-state')
    const wrap = document.getElementById('table-wrap')
    expect(empty?.hidden).toBe(false)
    expect(wrap?.hidden).toBe(true)
    // Meta line stays blank on empty state so the "N events" copy
    // never falsely reads "0 events".
    expect(document.getElementById('activity-meta')?.textContent).toBe('')
  })

  it('renders three events newest-first with the right columns', async () => {
    // Deliberate timestamp gaps so newest-first order is unambiguous.
    await appendEvent(evt({ ts: 100, site: 'chatgpt', action: 'protected', count: 2 }))
    await appendEvent(
      evt({
        ts: 200,
        site: 'claude',
        eventType: 'document',
        action: 'uploaded-anyway',
        count: 5,
      }),
    )
    await appendEvent(
      evt({
        ts: 300,
        site: 'gemini',
        eventType: 'document',
        action: 'auto-cleared',
        count: 0,
        categories: [],
        hadCriticalOrHigh: false,
      }),
    )

    const { render } = await loadActivityPage()
    await render()

    expect(document.getElementById('empty-state')?.hidden).toBe(true)
    expect(document.getElementById('table-wrap')?.hidden).toBe(false)
    expect(document.getElementById('activity-meta')?.textContent).toContain('3 events')

    const rows = document.querySelectorAll('#activity-rows tr')
    expect(rows).toHaveLength(3)

    // Newest-first: gemini (ts=300) first, chatgpt (ts=100) last.
    const firstCells = Array.from(rows[0].children).map((c) => c.textContent ?? '')
    expect(firstCells[1]).toBe('Gemini')
    expect(firstCells[2]).toBe('document')
    expect(firstCells[3]).toContain('auto-cleared')
    // auto-cleared has no categories and no maskable count.
    expect(firstCells[4]).toBe('—')
    expect(firstCells[5]).toBe('—')

    const middleCells = Array.from(rows[1].children).map((c) => c.textContent ?? '')
    expect(middleCells[1]).toBe('Claude')
    expect(middleCells[2]).toBe('document')
    expect(middleCells[3]).toContain('uploaded anyway')
    // Friendly category label (matches A4 modal copy).
    expect(middleCells[4]).toContain(CATEGORY_LABELS[DetectorCategory.HEALTHCARE_PATIENT_ID])
    expect(middleCells[5]).toBe('5')

    const lastCells = Array.from(rows[2].children).map((c) => c.textContent ?? '')
    expect(lastCells[1]).toBe('ChatGPT')
    expect(lastCells[5]).toBe('2')
  })

  it('renders at the ring-buffer max (200 events)', async () => {
    for (let i = 0; i < MAX_EVENTS; i++) {
      await appendEvent(evt({ ts: 1_000_000 + i, count: 1 }))
    }
    const { render } = await loadActivityPage()
    await render()
    const rows = document.querySelectorAll('#activity-rows tr')
    expect(rows).toHaveLength(MAX_EVENTS)
    expect(document.getElementById('activity-meta')?.textContent).toContain(
      `showing the most recent ${MAX_EVENTS}`,
    )
  })

  it('never renders a raw match value or filename anywhere in the DOM', async () => {
    // Hostile-value fixture — a paste-shaped AlgEvent with extras.
    // `appendEvent` projects them off at write time; this test
    // catches ANY regression where the projection is bypassed OR
    // the page grew a template that stringifies the whole event.
    const secret = 'SSN 987-65-4321'
    const filename = 'patient-records-2026.pdf'
    const hostile = {
      ...evt({ site: 'perplexity', action: 'uploaded-anyway' }),
      value: secret,
      text: `Patient MRN ${secret}`,
      filename,
      content: 'DO_NOT_LEAK',
    } as unknown as AlgEvent
    await appendEvent(hostile)

    const { render } = await loadActivityPage()
    await render()

    const domHtml = document.body.innerHTML
    for (const forbidden of [secret, '987-65-4321', filename, 'patient-records', 'DO_NOT_LEAK']) {
      expect(domHtml, `DOM should not contain ${JSON.stringify(forbidden)}`).not.toContain(
        forbidden,
      )
    }
  })
})
