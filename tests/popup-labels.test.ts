// @vitest-environment jsdom
//
// V1.2 A5.1 popup unit-clarity test.
//
// The popup has TWO count sources with different units — the
// headline number counts INDIVIDUAL sensitive items masked
// (`counters.total`, one match = one item) and the Activity
// tiles count EVENTS (one paste or one document = one event).
// This test pins that:
//   • the tile row is labelled with an explicit "events" unit,
//     visually distinct from the headline;
//   • the headline caption respects singular vs plural;
//   • both are derived from the fabricated counters + event
//     fixture with the expected values;
//   • no raw values / filenames land in the popup DOM.
//
// Kept as a real jsdom render against the popup HTML so a future
// change to the label copy or the tile IDs is caught by the
// assertions rather than sneaking through the code review.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DetectorCategory } from '../src/detector/types'
import type { AlgEvent } from '../src/shared/event-log'
import { appendEvent } from '../src/shared/event-log'
import { setCounters } from '../src/shared/storage'

// The popup module registers a DOMContentLoaded listener at import
// time and runs its render off it. To exercise that render
// deterministically, we (a) inject the popup markup into jsdom,
// (b) seed storage, then (c) import the module and dispatch
// `DOMContentLoaded`.
async function loadPopup(opts: {
  expectedTotal: string
  expectedTileDetected?: string
}): Promise<void> {
  const html = readFileSync(resolve('src/popup/index.html'), 'utf8')
  const body = html.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? html
  document.body.innerHTML = body
  // Fresh module each test so the DOMContentLoaded auto-invoke
  // re-runs against the newly-seeded storage.
  vi.resetModules()
  await import('../src/popup/popup')
  document.dispatchEvent(new Event('DOMContentLoaded'))
  // The popup renders counters first, then the activity section
  // via a second async pass. Poll on the observable end-state
  // (headline + tile) so a future added await in the render chain
  // doesn't silently race the assertions.
  await vi.waitFor(
    () => {
      expect(document.getElementById('total')?.textContent).toBe(opts.expectedTotal)
      if (opts.expectedTileDetected !== undefined) {
        expect(document.getElementById('stat-detected')?.textContent).toBe(
          opts.expectedTileDetected,
        )
      }
    },
    { timeout: 500, interval: 10 },
  )
}

function evt(overrides: Partial<AlgEvent> = {}): AlgEvent {
  return {
    ts: Date.now() - 60_000,
    site: 'chatgpt',
    eventType: 'paste',
    action: 'protected',
    categories: [DetectorCategory.GOVERNMENT_FINANCIAL],
    count: 1,
    hadCriticalOrHigh: true,
    ...overrides,
  }
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('popup — unit-clarity labels (A5.1)', () => {
  it('renders the headline in items-masked units, tiles in events units', async () => {
    // 7 individual sensitive items masked across 3 paste events —
    // deliberately different so a copy-paste of one count into
    // the other slot would fail the assertions.
    await setCounters({ total: 7, byType: {}, byDay: {} })
    await appendEvent(evt({ action: 'protected', count: 3 }))
    await appendEvent(evt({ action: 'protected', count: 3 }))
    await appendEvent(evt({ action: 'as-is', count: 1 }))

    await loadPopup({ expectedTotal: '7', expectedTileDetected: '3' })

    // Headline (items masked): 7, plural caption.
    expect(document.getElementById('total')?.textContent).toBe('7')
    expect(document.querySelector('.popup__caption')?.textContent).toBe('Sensitive items masked')

    // Activity heading uses the messages-and-files framing.
    expect(document.getElementById('activity-heading')?.textContent).toBe(
      'Messages & files checked',
    )
    // The hint line explicitly disambiguates the two units.
    const hint = document.querySelector('.activity__hint')?.textContent ?? ''
    expect(hint).toContain('EVENTS')
    expect(hint).toContain('INDIVIDUAL')

    // Tiles: 3 events fired total; 2 protected, 1 as-is; unit
    // label on every tile is "events".
    expect(document.getElementById('stat-detected')?.textContent).toBe('3')
    expect(document.getElementById('stat-protected')?.textContent).toBe('2')
    expect(document.getElementById('stat-as-is-or-released')?.textContent).toBe('1')
    expect(document.getElementById('stat-cancelled')?.textContent).toBe('0')

    const units = Array.from(document.querySelectorAll('.activity__unit')).map((n) => n.textContent)
    expect(units).toHaveLength(4)
    for (const u of units) expect(u).toBe('events')
  })

  it('uses singular caption when exactly 1 item has been masked', async () => {
    await setCounters({ total: 1, byType: {}, byDay: {} })
    await loadPopup({ expectedTotal: '1' })
    expect(document.querySelector('.popup__caption')?.textContent).toBe('Sensitive item masked')
  })

  it('never renders a raw matched value or filename in the popup DOM', async () => {
    // Fabricated hostile-value fixture — a paste-shaped event with
    // extras stapled on. `appendEvent` projects it (dropping
    // hostile keys before the storage write); this test enforces
    // that NEITHER the schema-shaped path NOR the raw-string path
    // ever lands in the popup DOM.
    const secret = 'SSN 123-45-6789'
    const filename = 'discharge-summary.pdf'
    const hostile = {
      ...evt(),
      value: secret,
      filename,
      text: `Patient MRN ${secret}`,
    } as unknown as AlgEvent
    await appendEvent(hostile)
    await setCounters({ total: 1, byType: {}, byDay: {} })

    await loadPopup({ expectedTotal: '1', expectedTileDetected: '1' })

    // Whole-page assertion — no forbidden literal appears anywhere.
    const domText = document.body.innerHTML
    expect(domText).not.toContain(secret)
    expect(domText).not.toContain('123-45-6789')
    expect(domText).not.toContain(filename)
    expect(domText).not.toContain('discharge-summary')
  })
})
