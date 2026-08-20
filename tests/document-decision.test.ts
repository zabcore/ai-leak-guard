// @vitest-environment jsdom
//
// V1.2 A4 shared decision helper tests. The helper is the single
// gate both file-paths route through — a bug here would silently
// break the FSA picker path and the change/drop/paste path in
// lockstep, so this suite explicitly exercises each aggregate
// branch, the anti-flicker delay, and the cancel-during-scanning
// short circuit.

import { describe, expect, it, vi } from 'vitest'
import type { FileInspection } from '../src/content/file-inspector'
import type {
  DocumentModalController,
  DocumentModalOutcome,
  SensitiveViewOpts,
  UnableViewOpts,
} from '../src/content/document-modal'
import { DetectorCategory } from '../src/detector/types'
import {
  aggregateBranch,
  firstUnableReason,
  resolveDocumentDecision,
} from '../src/content/document-decision'

// Flush enough microtasks that a `Promise.race([timerFired, ...])`
// chain has fully resolved and the surrounding async function has
// advanced past its next await. A single `await Promise.resolve()`
// flushes ONE microtask — not enough when the helper stacks a race
// on top of a resolved timer promise.
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

function cleanInspection(): FileInspection {
  return {
    perFile: [
      {
        meta: { file: new File([], 'a.txt'), name: 'a.txt', size: 0, type: 'text/plain' },
        extraction: {
          status: 'empty',
          text: '',
          reason: 'empty',
          meta: { name: 'a.txt', size: 0, type: 'text/plain', detectedFormat: 'text' },
        },
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

function sensitiveInspection(): FileInspection {
  return {
    perFile: [
      {
        meta: { file: new File([], 's.txt'), name: 's.txt', size: 0, type: 'text/plain' },
        extraction: {
          status: 'extracted',
          text: 'SSN 123-45-6789',
          meta: { name: 's.txt', size: 0, type: 'text/plain', detectedFormat: 'text' },
        },
        findings: [],
        scan: {
          state: 'sensitive',
          maskableCount: 1,
          categories: [DetectorCategory.GOVERNMENT_FINANCIAL],
          hasCriticalOrHigh: true,
        },
      },
    ],
    aggregate: {
      state: 'sensitive',
      totalMaskable: 1,
      categories: [DetectorCategory.GOVERNMENT_FINANCIAL],
      anyCriticalOrHigh: true,
      perStateCounts: { sensitive: 1, clean: 0, unable: 0 },
    },
  }
}

function unableInspection(): FileInspection {
  return {
    perFile: [
      {
        meta: {
          file: new File([], 'x.bin'),
          name: 'x.bin',
          size: 0,
          type: 'application/octet-stream',
        },
        extraction: {
          status: 'unable_to_inspect',
          text: '',
          reason: 'encrypted',
          meta: {
            name: 'x.bin',
            size: 0,
            type: 'application/octet-stream',
            detectedFormat: 'unknown',
          },
        },
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

type FakeModal = DocumentModalController & {
  readonly showSensitiveMock: ReturnType<typeof vi.fn>
  readonly showUnableMock: ReturnType<typeof vi.fn>
  readonly closeMock: ReturnType<typeof vi.fn>
  resolveOutcome(outcome: DocumentModalOutcome): void
}

function makeFakeModal(): FakeModal {
  let resolveOutcome!: (outcome: DocumentModalOutcome) => void
  const outcome = new Promise<DocumentModalOutcome>((resolve) => {
    resolveOutcome = resolve
  })
  const showSensitive = vi.fn((_opts: SensitiveViewOpts) => {
    // Sensitive view uses the primary [Upload anyway] — default the
    // fake to that outcome.
    resolveOutcome('upload-anyway')
  })
  const showUnable = vi.fn((_opts: UnableViewOpts) => {
    resolveOutcome('upload-anyway')
  })
  const close = vi.fn((o: DocumentModalOutcome) => resolveOutcome(o))
  return {
    outcome,
    showSensitive,
    showUnable,
    close,
    showSensitiveMock: showSensitive,
    showUnableMock: showUnable,
    closeMock: close,
    resolveOutcome,
  }
}

describe('aggregateBranch — pure classifier', () => {
  it('clean → auto-release', () => {
    expect(
      aggregateBranch({
        state: 'clean',
        totalMaskable: 0,
        categories: [],
        anyCriticalOrHigh: false,
        perStateCounts: { sensitive: 0, clean: 1, unable: 0 },
      }),
    ).toBe('auto-release')
  })
  it('sensitive → sensitive', () => {
    expect(
      aggregateBranch({
        state: 'sensitive',
        totalMaskable: 2,
        categories: [DetectorCategory.IDENTITY],
        anyCriticalOrHigh: true,
        perStateCounts: { sensitive: 1, clean: 0, unable: 0 },
      }),
    ).toBe('sensitive')
  })
  it('unable_to_inspect → unable', () => {
    expect(
      aggregateBranch({
        state: 'unable_to_inspect',
        totalMaskable: 0,
        categories: [],
        anyCriticalOrHigh: false,
        perStateCounts: { sensitive: 0, clean: 0, unable: 1 },
      }),
    ).toBe('unable')
  })
})

describe('firstUnableReason — pure', () => {
  it('returns the reason from the first unable file', () => {
    expect(firstUnableReason(unableInspection())).toBe('encrypted')
  })
  it('returns undefined when nothing is unable', () => {
    expect(firstUnableReason(cleanInspection())).toBeUndefined()
  })
})

describe('resolveDocumentDecision — clean aggregate', () => {
  it('resolves upload-anyway WITHOUT opening a modal (fast inspection)', async () => {
    const openModal = vi.fn(() => makeFakeModal())
    const decision = await resolveDocumentDecision(Promise.resolve(cleanInspection()), {
      opener: null,
      deps: {
        openModal,
        // 0 ms flicker delay: inspection still wins the race because
        // it's a resolved promise (microtask) vs a macrotask timer.
        flickerDelayMs: 0,
      },
    })
    expect(decision).toBe('upload-anyway')
    expect(openModal).not.toHaveBeenCalled()
  })

  it('closes the scanning modal as upload-anyway when a SLOW clean scan resolves', async () => {
    // Force the scanning view by making the timer fire before
    // inspection settles.
    const modal = makeFakeModal()
    const openModal = vi.fn(() => modal)
    let resolveInspection!: (inspection: FileInspection) => void
    const inspectionPromise = new Promise<FileInspection>((resolve) => {
      resolveInspection = resolve
    })

    const promise = resolveDocumentDecision(inspectionPromise, {
      opener: null,
      deps: {
        openModal,
        // Immediate scanning view — timer resolves first, then we
        // release the (clean) inspection.
        setTimer: (fn) => {
          fn()
          return 0
        },
        clearTimer: () => {},
      },
    })
    // Flush microtasks past the openModal call (Promise.race needs a
    // couple of them to run its internal handlers).
    await flushMicrotasks()
    expect(openModal).toHaveBeenCalledOnce()
    resolveInspection(cleanInspection())
    await expect(promise).resolves.toBe('upload-anyway')
    // The helper closed the modal programmatically rather than
    // leaving a stale spinner on screen.
    expect(modal.closeMock).toHaveBeenCalledWith('upload-anyway')
    expect(modal.showSensitiveMock).not.toHaveBeenCalled()
    expect(modal.showUnableMock).not.toHaveBeenCalled()
  })
})

describe('resolveDocumentDecision — sensitive aggregate', () => {
  it('fast scan → opens modal directly in sensitive view with correct summary', async () => {
    const modal = makeFakeModal()
    const openModal = vi.fn(() => modal)
    const promise = resolveDocumentDecision(Promise.resolve(sensitiveInspection()), {
      opener: null,
      deps: {
        openModal,
        // Ensure inspection wins the race even if the runtime is slow.
        setTimer: () => 1,
        clearTimer: () => {},
      },
    })
    await expect(promise).resolves.toBe('upload-anyway')
    expect(openModal).toHaveBeenCalledOnce()
    expect(modal.showSensitiveMock).toHaveBeenCalledOnce()
    const call = modal.showSensitiveMock.mock.calls[0]?.[0] as SensitiveViewOpts
    expect(call.totalMaskable).toBe(1)
    expect(call.categories).toEqual([DetectorCategory.GOVERNMENT_FINANCIAL])
    expect(call.hasCriticalOrHigh).toBe(true)
    expect(call.fileCount).toBe(1)
  })

  it('slow sensitive scan → paints scanning first, then transitions to sensitive view', async () => {
    const modal = makeFakeModal()
    const openModal = vi.fn(() => modal)
    let resolveInspection!: (inspection: FileInspection) => void
    const inspectionPromise = new Promise<FileInspection>((resolve) => {
      resolveInspection = resolve
    })
    const promise = resolveDocumentDecision(inspectionPromise, {
      opener: null,
      deps: {
        openModal,
        setTimer: (fn) => {
          fn()
          return 0
        },
        clearTimer: () => {},
      },
    })
    await flushMicrotasks()
    expect(openModal).toHaveBeenCalledOnce()
    // No transition yet — the modal is in scanning state.
    expect(modal.showSensitiveMock).not.toHaveBeenCalled()
    resolveInspection(sensitiveInspection())
    await expect(promise).resolves.toBe('upload-anyway')
    expect(modal.showSensitiveMock).toHaveBeenCalledOnce()
  })
})

describe('resolveDocumentDecision — unable aggregate', () => {
  it('opens modal in unable view with the first-unable reason', async () => {
    const modal = makeFakeModal()
    const openModal = vi.fn(() => modal)
    const promise = resolveDocumentDecision(Promise.resolve(unableInspection()), {
      opener: null,
      deps: {
        openModal,
        setTimer: () => 1,
        clearTimer: () => {},
      },
    })
    await expect(promise).resolves.toBe('upload-anyway')
    expect(modal.showUnableMock).toHaveBeenCalledOnce()
    const call = modal.showUnableMock.mock.calls[0]?.[0] as UnableViewOpts
    expect(call.fileCount).toBe(1)
    expect(call.reason).toBe('encrypted')
  })
})

describe('resolveDocumentDecision — cancel during scanning', () => {
  it('user cancel while the scan is still running → resolves cancel (forwards modal outcome)', async () => {
    const modal = makeFakeModal()
    const openModal = vi.fn(() => modal)
    let resolveInspection!: (inspection: FileInspection) => void
    const inspectionPromise = new Promise<FileInspection>((resolve) => {
      resolveInspection = resolve
    })
    const promise = resolveDocumentDecision(inspectionPromise, {
      opener: null,
      deps: {
        openModal,
        setTimer: (fn) => {
          fn()
          return 0
        },
        clearTimer: () => {},
      },
    })
    // Scanning view is painted; user hits Cancel BEFORE inspection
    // resolves.
    await flushMicrotasks()
    modal.resolveOutcome('cancel')
    // Let the cancel-race resolve so the helper returns early
    // BEFORE the inspection settles as sensitive.
    await flushMicrotasks()
    resolveInspection(sensitiveInspection())
    await expect(promise).resolves.toBe('cancel')
    // We must NOT transition to sensitive after the cancel.
    expect(modal.showSensitiveMock).not.toHaveBeenCalled()
  })
})

describe('resolveDocumentDecision — cancels/clears the flicker timer on fast scan', () => {
  it('inspection wins the race → clearTimer is invoked', async () => {
    const clearTimer = vi.fn()
    let capturedId: number | null = null
    await resolveDocumentDecision(Promise.resolve(cleanInspection()), {
      opener: null,
      deps: {
        openModal: () => makeFakeModal(),
        setTimer: () => {
          capturedId = 42
          return 42
        },
        clearTimer,
      },
    })
    expect(capturedId).toBe(42)
    expect(clearTimer).toHaveBeenCalledWith(42)
  })
})
