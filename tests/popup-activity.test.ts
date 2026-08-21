// @vitest-environment jsdom
//
// V1.2 A5 (#40) popup activity-section renderer test.
//
// The popup receives METADATA ONLY from `chrome.storage.local`; the
// event schema deliberately excludes value/text/filename fields, so
// the DOM CAN'T carry a raw value even if popup code tried to
// render one. This test also proves the recent-activity strings
// stay metadata-only (a hostile future edit that started
// interpolating `event.value` would be caught by both the type
// system AND by the "no raw literal in the DOM" assertion below).

import { beforeEach, describe, expect, it } from 'vitest'
import { DetectorCategory } from '../src/detector/types'
import { formatRecentLine } from '../src/popup/popup'
import type { AlgEvent } from '../src/shared/event-log'

function evt(overrides: Partial<AlgEvent> = {}): AlgEvent {
  return {
    ts: Date.now() - 60_000,
    site: 'chatgpt',
    eventType: 'paste',
    action: 'protected',
    categories: [DetectorCategory.GOVERNMENT_FINANCIAL],
    count: 2,
    hadCriticalOrHigh: true,
    ...overrides,
  }
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('formatRecentLine — metadata-only compact string', () => {
  const NOW = 1_700_000_000_000

  it('paste protected: "ChatGPT · paste · 2 items · protected · 1m ago"', () => {
    const line = formatRecentLine(evt({ ts: NOW - 60_000 }), NOW)
    expect(line).toBe('ChatGPT · paste · 2 items · protected · 1m ago')
  })

  it('document uploaded-anyway with 1 item: singular noun', () => {
    const line = formatRecentLine(
      evt({
        eventType: 'document',
        action: 'uploaded-anyway',
        count: 1,
        site: 'claude',
        ts: NOW - 5 * 60_000,
      }),
      NOW,
    )
    expect(line).toBe('Claude · document · 1 item · uploaded anyway · 5m ago')
  })

  it('clean auto-cleared document says "clean" instead of a count', () => {
    const line = formatRecentLine(
      evt({
        eventType: 'document',
        action: 'auto-cleared',
        count: 0,
        categories: [],
        hadCriticalOrHigh: false,
        site: 'gemini',
        ts: NOW - 30_000,
      }),
      NOW,
    )
    expect(line).toBe('Gemini · document · clean · auto-cleared · just now')
  })

  it('unable-to-inspect uses the friendly action verb', () => {
    const line = formatRecentLine(
      evt({
        eventType: 'document',
        action: 'unable-to-inspect',
        count: 0,
        categories: [],
        hadCriticalOrHigh: false,
        site: 'perplexity',
        ts: NOW - 3 * 60 * 60_000,
      }),
      NOW,
    )
    expect(line).toBe("Perplexity · document · couldn't inspect · 3h ago")
  })

  it('never contains a filename-shaped or value-shaped substring — schema has neither', () => {
    // Belt-and-braces: the AlgEvent shape has no `value`/`filename`
    // to begin with, but the formatter must never fabricate one.
    // Simulate a future accidental field bleed by adding
    // content-shaped keys to the input; the formatter must ignore
    // them. Cast through `unknown` — the AlgEvent type has none of
    // these fields on purpose, so TypeScript needs the escape hatch
    // to construct the hostile shape at all.
    const bleed = {
      ...evt(),
      value: '123-45-6789',
      filename: 'ssn-list.xlsx',
      text: 'Patient MRN 42',
    } as unknown as AlgEvent
    const line = formatRecentLine(bleed, NOW)
    expect(line).not.toContain('123-45-6789')
    expect(line).not.toContain('ssn-list.xlsx')
    expect(line).not.toContain('Patient MRN 42')
  })
})
