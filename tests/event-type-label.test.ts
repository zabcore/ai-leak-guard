// V1.3 M7 — friendly event-SOURCE labels (UI-label polish).
//
// DISPLAY ONLY: the activity page + popup render `paste` / `submit` /
// `document` as "Paste" / "Send" / "File upload". The STORED eventType
// values and the event-log schema/export stay the raw enum — pinned by
// the event-log and export suites — so this maps display copy without
// touching persistence.

import { describe, expect, it } from 'vitest'
import { eventTypeLabel, EVENT_TYPE_LABELS } from '../src/popup/labels'

describe('eventTypeLabel — friendly source copy (display only)', () => {
  it('maps the three stored event types to friendly labels', () => {
    expect(eventTypeLabel('paste')).toBe('Paste')
    expect(eventTypeLabel('submit')).toBe('Send')
    expect(eventTypeLabel('document')).toBe('File upload')
  })

  it('degrades an unlisted future type to its raw value', () => {
    expect(eventTypeLabel('voice')).toBe('voice')
    expect(eventTypeLabel('')).toBe('')
  })

  it('the mapping table only renames the three known types (no stored-value rewrite)', () => {
    // The label table's KEYS are exactly the raw stored eventType values —
    // it renames for display, it does not introduce new stored values.
    expect(Object.keys(EVENT_TYPE_LABELS).sort()).toEqual(['document', 'paste', 'submit'])
  })
})
