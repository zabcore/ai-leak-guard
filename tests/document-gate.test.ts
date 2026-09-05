// @vitest-environment jsdom
//
// V1.3 M4 — the document coordination gate, plus the attach-time flow
// that publishes into it. Two layers:
//   1. the in-memory registry itself (pending → settle → clear, waiters,
//      acknowledge, default snapshot);
//   2. `resolveDocumentDecision` populating the gate from a real
//      inspection lifecycle (detected/clean/unable + upload-anyway /
//      cancel), and staying byte-identical to V1.2 when no composerKey
//      is passed.

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getDoc,
  markDocPending,
  settleDoc,
  markDocAcknowledged,
  clearDoc,
  whenDocSettled,
  __resetDocumentGateForTests,
} from '../src/content/submit/document-gate'
import { resolveDocumentDecision } from '../src/content/document-decision'
import type { FileInspection } from '../src/content/file-inspector'
import type { DocumentModalController, DocumentModalOutcome } from '../src/content/document-modal'
import { DetectorCategory } from '../src/detector/types'

const KEY = 'chatgpt-composer'

afterEach(() => {
  __resetDocumentGateForTests()
  vi.restoreAllMocks()
})

describe('document-gate — in-memory registry', () => {
  it('defaults to {status:none, acknowledged:false}', () => {
    expect(getDoc(KEY)).toEqual({ status: 'none', acknowledged: false })
  })

  it('markDocPending → pending; whenDocSettled stays unresolved until settle', async () => {
    markDocPending(KEY)
    expect(getDoc(KEY).status).toBe('pending')
    let resolved: unknown = null
    void whenDocSettled(KEY).then((s) => (resolved = s))
    await Promise.resolve()
    expect(resolved).toBeNull() // still pending
    settleDoc(KEY, { status: 'clean' })
    await Promise.resolve()
    expect((resolved as { status: string }).status).toBe('clean')
  })

  it('settleDoc detected carries summary + fileCount; whenDocSettled resolves immediately when not pending', async () => {
    settleDoc(KEY, {
      status: 'detected',
      summary: { categories: [DetectorCategory.IDENTITY], count: 2, hasCriticalOrHigh: true },
      fileCount: 2,
    })
    const snap = getDoc(KEY)
    expect(snap.status).toBe('detected')
    expect(snap.summary?.count).toBe(2)
    expect(snap.fileCount).toBe(2)
    await expect(whenDocSettled(KEY)).resolves.toMatchObject({ status: 'detected' })
  })

  it('markDocAcknowledged sets the flag; settle preserves it when not overridden', () => {
    settleDoc(KEY, {
      status: 'detected',
      summary: { categories: [], count: 1, hasCriticalOrHigh: false },
      fileCount: 1,
    })
    markDocAcknowledged(KEY)
    expect(getDoc(KEY).acknowledged).toBe(true)
    // A re-settle (e.g. re-inspection) that doesn't pass acknowledged keeps it.
    settleDoc(KEY, {
      status: 'detected',
      summary: { categories: [], count: 1, hasCriticalOrHigh: false },
      fileCount: 1,
    })
    expect(getDoc(KEY).acknowledged).toBe(true)
  })

  it('clearDoc resets to none and wakes a parked waiter with none', async () => {
    markDocPending(KEY)
    let resolved: { status: string } | null = null
    void whenDocSettled(KEY).then((s) => (resolved = s as { status: string }))
    clearDoc(KEY)
    await Promise.resolve()
    expect(getDoc(KEY)).toEqual({ status: 'none', acknowledged: false })
    expect(resolved!.status).toBe('none')
  })
})

// ── attach-time flow → gate integration ──

function inspectionOf(state: 'clean' | 'sensitive' | 'unable_to_inspect'): FileInspection {
  const scan =
    state === 'sensitive'
      ? {
          state,
          maskableCount: 1,
          categories: [DetectorCategory.GOVERNMENT_FINANCIAL],
          hasCriticalOrHigh: true,
        }
      : state === 'unable_to_inspect'
        ? {
            state,
            maskableCount: 0,
            categories: [],
            hasCriticalOrHigh: false,
            reason: 'encrypted' as const,
          }
        : { state, maskableCount: 0, categories: [], hasCriticalOrHigh: false }
  return {
    perFile: [
      {
        meta: { file: new File([], 'f'), name: 'f', size: 0, type: 'text/plain' },
        extraction:
          state === 'unable_to_inspect'
            ? {
                status: 'unable_to_inspect',
                text: '',
                reason: 'encrypted',
                meta: { name: 'f', size: 0, type: 'text/plain', detectedFormat: 'unknown' },
              }
            : {
                status: 'extracted',
                text: 'x',
                meta: { name: 'f', size: 0, type: 'text/plain', detectedFormat: 'text' },
              },
        findings: [],
        scan,
      },
    ],
    aggregate: {
      state,
      totalMaskable: scan.maskableCount,
      categories: scan.categories,
      anyCriticalOrHigh: scan.hasCriticalOrHigh,
      perStateCounts: {
        sensitive: state === 'sensitive' ? 1 : 0,
        clean: state === 'clean' ? 1 : 0,
        unable: state === 'unable_to_inspect' ? 1 : 0,
      },
    },
  }
}

// Fake modal that resolves with a fixed outcome as soon as a view is shown.
function fakeModal(outcome: DocumentModalOutcome): () => DocumentModalController {
  return () => {
    let resolve!: (o: DocumentModalOutcome) => void
    const p = new Promise<DocumentModalOutcome>((r) => (resolve = r))
    return {
      outcome: p,
      showSensitive: () => resolve(outcome),
      showUnable: () => resolve(outcome),
      close: (o) => resolve(o),
    }
  }
}

async function runDecision(
  state: 'clean' | 'sensitive' | 'unable_to_inspect',
  outcome: DocumentModalOutcome,
  composerKey: string | undefined,
): Promise<DocumentModalOutcome> {
  return resolveDocumentDecision(Promise.resolve(inspectionOf(state)), {
    opener: null,
    composerKey,
    deps: { openModal: fakeModal(outcome), flickerDelayMs: 0 },
  })
}

describe('document-decision → gate population', () => {
  it('sensitive + upload-anyway ⇒ gate detected + acknowledged, with summary/fileCount', async () => {
    await runDecision('sensitive', 'upload-anyway', KEY)
    const snap = getDoc(KEY)
    expect(snap.status).toBe('detected')
    expect(snap.acknowledged).toBe(true)
    expect(snap.summary?.count).toBe(1)
    expect(snap.fileCount).toBe(1)
  })

  it('sensitive + cancel ⇒ gate cleared (file never attached)', async () => {
    await runDecision('sensitive', 'cancel', KEY)
    expect(getDoc(KEY)).toEqual({ status: 'none', acknowledged: false })
  })

  it('clean ⇒ gate clean (no decision needed at send)', async () => {
    await runDecision('clean', 'upload-anyway', KEY)
    expect(getDoc(KEY).status).toBe('clean')
  })

  it('unable + upload-anyway ⇒ gate unable-to-inspect + acknowledged', async () => {
    await runDecision('unable_to_inspect', 'upload-anyway', KEY)
    const snap = getDoc(KEY)
    expect(snap.status).toBe('unable-to-inspect')
    expect(snap.acknowledged).toBe(true)
  })

  it('no composerKey ⇒ no gate writes (byte-identical to V1.2)', async () => {
    await runDecision('sensitive', 'upload-anyway', undefined)
    expect(getDoc(KEY)).toEqual({ status: 'none', acknowledged: false })
  })
})
