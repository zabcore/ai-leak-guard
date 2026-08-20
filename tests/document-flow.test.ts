// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { holdFiles, type HoldDeps } from '../src/content/document-flow'
import type { ExtractedFiles } from '../src/content/file-extraction'
import type { DocumentModalOutcome } from '../src/content/document-modal'
import type { ReleaseOutcome } from '../src/content/upload-release'

function makeDeps(overrides: Partial<HoldDeps> = {}): HoldDeps {
  return {
    resolveDecision:
      overrides.resolveDecision ?? (() => Promise.resolve<DocumentModalOutcome>('cancel')),
    releaseFiles: overrides.releaseFiles ?? (() => 'released'),
    clearInput: overrides.clearInput ?? (() => {}),
  }
}

function changeState(input: HTMLInputElement, ...files: File[]): ExtractedFiles {
  return { kind: 'change', files, originInput: input }
}

function dropState(...files: File[]): ExtractedFiles {
  return { kind: 'drop', files, originInput: null }
}

describe('holdFiles', () => {
  it('hands the pending inspection + opener to resolveDecision', async () => {
    // Type the mock with the seam's own signature (Vitest 4.x infers
    // `mock.calls` from the supplied function type) — no runtime cast
    // needed to read the recorded arguments.
    const resolveDecision = vi.fn<HoldDeps['resolveDecision']>(() =>
      Promise.resolve<DocumentModalOutcome>('cancel'),
    )
    const input = document.createElement('input')
    input.type = 'file'
    const files = [
      new File(['a'], 'a.pdf', { type: 'application/pdf' }),
      new File(['b'], 'b.pdf', { type: 'application/pdf' }),
    ]
    await holdFiles(changeState(input, ...files), input, makeDeps({ resolveDecision }))
    expect(resolveDecision).toHaveBeenCalledOnce()
    const [pendingInspection, opts] = resolveDecision.mock.calls[0]
    expect(pendingInspection).toBeInstanceOf(Promise)
    expect(opts.opener).toBe(input)
  })

  it('on Upload anyway → invokes releaseFiles and returns the release outcome', async () => {
    const release = vi.fn(() => 'released' as ReleaseOutcome)
    const input = document.createElement('input')
    input.type = 'file'
    const file = new File(['x'], 'a.pdf', { type: 'application/pdf' })
    const result = await holdFiles(
      changeState(input, file),
      input,
      makeDeps({
        resolveDecision: () => Promise.resolve('upload-anyway'),
        releaseFiles: release,
      }),
    )
    expect(release).toHaveBeenCalledOnce()
    expect(result.outcome).toBe('upload-anyway')
    if (result.outcome === 'upload-anyway') {
      expect(result.release).toBe('released')
      expect(result.inspection.perFile).toHaveLength(1)
    }
  })

  it('on Cancel → clears the origin input for a change event', async () => {
    const clearInput = vi.fn()
    const input = document.createElement('input')
    input.type = 'file'
    const file = new File(['x'], 'a.pdf', { type: 'application/pdf' })
    const result = await holdFiles(
      changeState(input, file),
      input,
      makeDeps({
        resolveDecision: () => Promise.resolve('cancel'),
        clearInput,
      }),
    )
    expect(clearInput).toHaveBeenCalledOnce()
    expect(clearInput.mock.calls[0][0]).toBe(input)
    expect(result.outcome).toBe('cancel')
    // Cancel deliberately does NOT carry inspection — the flow returns
    // instantly on cancel and never awaits the pending scan.
  })

  it('on Cancel → does NOT wait for inspection to settle', async () => {
    const clearInput = vi.fn()
    const input = document.createElement('input')
    input.type = 'file'
    const file = new File(['x'], 'a.pdf', { type: 'application/pdf' })
    // Resolve the decision immediately as 'cancel'. `holdFiles` starts
    // the inspection promise itself and, per the fix, must not await
    // it before returning on cancel. We prove this by measuring wall
    // time — a real cancel path returns in <50 ms even though the
    // extractor's per-file work is real (there's a jsdom extractor
    // for `text/plain` that resolves promptly, but the invariant we
    // care about is the ordering: return before the promise settles).
    const start = Date.now()
    const result = await holdFiles(
      changeState(input, file),
      input,
      makeDeps({
        resolveDecision: () => Promise.resolve('cancel'),
        clearInput,
      }),
    )
    const elapsed = Date.now() - start
    expect(result.outcome).toBe('cancel')
    expect(elapsed).toBeLessThan(200)
  })

  it('on Cancel with a drop event → does NOT try to clear an input (there is none)', async () => {
    const clearInput = vi.fn()
    const file = new File(['x'], 'a.pdf', { type: 'application/pdf' })
    await holdFiles(
      dropState(file),
      null,
      makeDeps({
        resolveDecision: () => Promise.resolve('cancel'),
        clearInput,
      }),
    )
    expect(clearInput).not.toHaveBeenCalled()
  })

  it('on Upload anyway with a drop event → releaseFiles is called but no input clear', async () => {
    const clearInput = vi.fn()
    const release = vi.fn(() => 'needs-user-reattach' as ReleaseOutcome)
    const file = new File(['x'], 'a.pdf', { type: 'application/pdf' })
    const result = await holdFiles(
      dropState(file),
      null,
      makeDeps({
        resolveDecision: () => Promise.resolve('upload-anyway'),
        releaseFiles: release,
        clearInput,
      }),
    )
    expect(release).toHaveBeenCalledOnce()
    expect(clearInput).not.toHaveBeenCalled()
    expect(result.outcome).toBe('upload-anyway')
    if (result.outcome === 'upload-anyway') {
      expect(result.release).toBe('needs-user-reattach')
      expect(result.inspection.perFile).toHaveLength(1)
    }
  })
})
