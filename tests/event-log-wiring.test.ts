// @vitest-environment jsdom
//
// V1.2 A5 (#40) event-log wire tests. Pins the mapping from a
// resolved `DocumentModalOutcome` × `AggregateScanResult` state
// onto the AlgEvent's `action` field. The moat-rule "no content"
// guard and ring-buffer behavior live in `event-log.test.ts`;
// this suite only verifies the WIRING at the document-decision
// helper (the paste path's wire is a one-liner in `index.ts`,
// covered by inspection).

import { describe, expect, it, vi } from 'vitest'
import type { FileInspection } from '../src/content/file-inspector'
import type {
  DocumentModalController,
  DocumentModalOutcome,
  SensitiveViewOpts,
  UnableViewOpts,
} from '../src/content/document-modal'
import { DetectorCategory } from '../src/detector/types'
import { resolveDocumentDecision } from '../src/content/document-decision'
import type { AlgEvent } from '../src/shared/event-log'

function inspectionFor(state: 'clean' | 'sensitive' | 'unable_to_inspect'): FileInspection {
  const meta = { name: 'a.txt', size: 0, type: 'text/plain', detectedFormat: 'text' as const }
  const file = new File([], 'a.txt')
  if (state === 'clean') {
    return {
      perFile: [
        {
          meta: { file, name: 'a.txt', size: 0, type: 'text/plain' },
          extraction: { status: 'empty', text: '', reason: 'empty', meta },
          findings: [],
          scan: { state: 'clean', maskableCount: 0, categories: [], hasCriticalOrHigh: false },
        },
      ],
      aggregate: {
        state: 'clean',
        totalMaskable: 0,
        categories: [],
        anyCriticalOrHigh: false,
        perStateCounts: { sensitive: 0, clean: 1, unable: 0 },
      },
    }
  }
  if (state === 'sensitive') {
    return {
      perFile: [
        {
          meta: { file, name: 'a.txt', size: 0, type: 'text/plain' },
          extraction: { status: 'extracted', text: 'x', meta },
          findings: [],
          scan: {
            state: 'sensitive',
            maskableCount: 3,
            categories: [DetectorCategory.HEALTHCARE_PATIENT_ID],
            hasCriticalOrHigh: true,
          },
        },
      ],
      aggregate: {
        state: 'sensitive',
        totalMaskable: 3,
        categories: [DetectorCategory.HEALTHCARE_PATIENT_ID],
        anyCriticalOrHigh: true,
        perStateCounts: { sensitive: 1, clean: 0, unable: 0 },
      },
    }
  }
  return {
    perFile: [
      {
        meta: { file, name: 'a.txt', size: 0, type: 'text/plain' },
        extraction: { status: 'unable_to_inspect', text: '', reason: 'encrypted', meta },
        findings: [],
        scan: {
          state: 'unable_to_inspect',
          maskableCount: 0,
          categories: [],
          hasCriticalOrHigh: false,
          reason: 'encrypted',
        },
      },
    ],
    aggregate: {
      state: 'unable_to_inspect',
      totalMaskable: 0,
      categories: [],
      anyCriticalOrHigh: false,
      perStateCounts: { sensitive: 0, clean: 0, unable: 1 },
    },
  }
}

function makeFakeModal(defaultOutcome: DocumentModalOutcome = 'upload-anyway'): {
  readonly ctrl: DocumentModalController
  readonly showSensitive: ReturnType<typeof vi.fn>
  readonly showUnable: ReturnType<typeof vi.fn>
} {
  let resolveOutcome!: (o: DocumentModalOutcome) => void
  const outcome = new Promise<DocumentModalOutcome>((r) => {
    resolveOutcome = r
  })
  const showSensitive = vi.fn((_opts: SensitiveViewOpts) => resolveOutcome(defaultOutcome))
  const showUnable = vi.fn((_opts: UnableViewOpts) => resolveOutcome(defaultOutcome))
  const close = vi.fn((o: DocumentModalOutcome) => resolveOutcome(o))
  return {
    ctrl: { outcome, showSensitive, showUnable, close },
    showSensitive,
    showUnable,
  }
}

async function run(
  state: 'clean' | 'sensitive' | 'unable_to_inspect',
  modalOutcome: DocumentModalOutcome,
): Promise<AlgEvent[]> {
  const logged: AlgEvent[] = []
  const { ctrl } = makeFakeModal(modalOutcome)
  await resolveDocumentDecision(Promise.resolve(inspectionFor(state)), {
    opener: null,
    siteId: 'chatgpt',
    deps: {
      openModal: () => ctrl,
      flickerDelayMs: 0,
      logEvent: (e) => logged.push(e),
    },
  })
  return logged
}

describe('resolveDocumentDecision — event-log wiring', () => {
  it('clean → auto-cleared, count=0, categories=[]', async () => {
    const [event] = await run('clean', 'upload-anyway')
    expect(event.eventType).toBe('document')
    expect(event.action).toBe('auto-cleared')
    expect(event.count).toBe(0)
    expect(event.categories).toEqual([])
    expect(event.site).toBe('chatgpt')
  })

  it('sensitive + upload-anyway → uploaded-anyway with aggregate metadata', async () => {
    const [event] = await run('sensitive', 'upload-anyway')
    expect(event.action).toBe('uploaded-anyway')
    expect(event.count).toBe(3)
    expect(event.hadCriticalOrHigh).toBe(true)
    expect(event.categories).toEqual([DetectorCategory.HEALTHCARE_PATIENT_ID])
  })

  it('sensitive + cancel → cancelled with aggregate metadata', async () => {
    const [event] = await run('sensitive', 'cancel')
    expect(event.action).toBe('cancelled')
    expect(event.count).toBe(3)
    expect(event.categories).toEqual([DetectorCategory.HEALTHCARE_PATIENT_ID])
  })

  it('unable + upload-anyway → unable-to-inspect with empty metadata', async () => {
    const [event] = await run('unable_to_inspect', 'upload-anyway')
    expect(event.action).toBe('unable-to-inspect')
    expect(event.count).toBe(0)
    expect(event.categories).toEqual([])
    expect(event.hadCriticalOrHigh).toBe(false)
  })

  it('unable + cancel → cancelled with empty metadata', async () => {
    const [event] = await run('unable_to_inspect', 'cancel')
    expect(event.action).toBe('cancelled')
    expect(event.count).toBe(0)
  })

  it('does NOT log when siteId is empty (opt-in gate)', async () => {
    const logged: AlgEvent[] = []
    const { ctrl } = makeFakeModal('upload-anyway')
    await resolveDocumentDecision(Promise.resolve(inspectionFor('sensitive')), {
      opener: null,
      // siteId omitted → defaults to '' → log path skipped.
      deps: {
        openModal: () => ctrl,
        flickerDelayMs: 0,
        logEvent: (e) => logged.push(e),
      },
    })
    expect(logged).toEqual([])
  })

  it('never persists any content-shaped field on the emitted event', async () => {
    // Belt-and-braces at the wire boundary — even though `event-log.test.ts`
    // pins the persisted storage payload, a broken caller could still put
    // content on the event object it hands to `logEvent`.
    const forbidden = ['value', 'text', 'content', 'name', 'filename', 'body', 'raw']
    const cases: Array<['clean' | 'sensitive' | 'unable_to_inspect', DocumentModalOutcome]> = [
      ['clean', 'upload-anyway'],
      ['sensitive', 'upload-anyway'],
      ['sensitive', 'cancel'],
      ['unable_to_inspect', 'upload-anyway'],
      ['unable_to_inspect', 'cancel'],
    ]
    for (const [state, outcome] of cases) {
      const [event] = await run(state, outcome)
      for (const key of forbidden) {
        expect(event, `${state}/${outcome} event carries '${key}'`).not.toHaveProperty(key)
      }
    }
  })
})
