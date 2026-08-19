// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { holdFiles, type HoldDeps } from '../src/content/document-flow'
import type { ExtractedFiles } from '../src/content/file-extraction'
import type { DocumentModalOutcome } from '../src/content/document-modal'
import type { ReleaseOutcome } from '../src/content/upload-release'

function makeDeps(overrides: Partial<HoldDeps> = {}): HoldDeps {
  return {
    showModal: overrides.showModal ?? (() => Promise.resolve('cancel')),
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
  it('opens the modal with the correct file count', async () => {
    const showModal: HoldDeps['showModal'] = vi.fn(() =>
      Promise.resolve<DocumentModalOutcome>('cancel'),
    )
    const input = document.createElement('input')
    input.type = 'file'
    const files = [
      new File(['a'], 'a.pdf', { type: 'application/pdf' }),
      new File(['b'], 'b.pdf', { type: 'application/pdf' }),
    ]
    await holdFiles(changeState(input, ...files), input, makeDeps({ showModal }))
    const mock = showModal as unknown as ReturnType<typeof vi.fn>
    expect(mock).toHaveBeenCalledOnce()
    const call = mock.mock.calls[0] as [{ fileCount: number; opener: Element | null }]
    expect(call[0].fileCount).toBe(2)
    expect(call[0].opener).toBe(input)
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
        showModal: () => Promise.resolve('upload-anyway'),
        releaseFiles: release,
      }),
    )
    expect(release).toHaveBeenCalledOnce()
    expect(result.outcome).toBe('upload-anyway')
    if (result.outcome === 'upload-anyway') expect(result.release).toBe('released')
    expect(result.inspection.perFile).toHaveLength(1)
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
        showModal: () => Promise.resolve('cancel'),
        clearInput,
      }),
    )
    expect(clearInput).toHaveBeenCalledOnce()
    expect(clearInput.mock.calls[0][0]).toBe(input)
    expect(result.outcome).toBe('cancel')
    expect(result.inspection.perFile).toHaveLength(1)
  })

  it('on Cancel with a drop event → does NOT try to clear an input (there is none)', async () => {
    const clearInput = vi.fn()
    const file = new File(['x'], 'a.pdf', { type: 'application/pdf' })
    await holdFiles(
      dropState(file),
      null,
      makeDeps({
        showModal: () => Promise.resolve('cancel'),
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
        showModal: () => Promise.resolve('upload-anyway'),
        releaseFiles: release,
        clearInput,
      }),
    )
    expect(release).toHaveBeenCalledOnce()
    expect(clearInput).not.toHaveBeenCalled()
    expect(result.outcome).toBe('upload-anyway')
    if (result.outcome === 'upload-anyway') expect(result.release).toBe('needs-user-reattach')
    expect(result.inspection.perFile).toHaveLength(1)
  })
})
