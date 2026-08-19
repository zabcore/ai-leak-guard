// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createWrappedPicker,
  installFsaHook,
  type FileHandleLike,
} from '../src/content/main-world/fsa-hook'
import type { FsaDecision, FsaFileMetadata } from '../src/content/main-world/fsa-messages'

function fakeHandle(file: File): FileHandleLike {
  return { getFile: () => Promise.resolve(file) }
}

afterEach(() => {
  vi.restoreAllMocks()
  // Any test that installed on window must reset it.
  delete (window as unknown as { showOpenFilePicker?: unknown }).showOpenFilePicker
})

describe('createWrappedPicker', () => {
  it('returns the ORIGINAL handles when the decision is upload-anyway', async () => {
    const file = new File(['x'], 'a.pdf', { type: 'application/pdf' })
    const handles = [fakeHandle(file)]
    const orig = vi.fn(() => Promise.resolve(handles))
    const askDecision = vi.fn(() => Promise.resolve<FsaDecision>('upload-anyway'))

    const wrapped = createWrappedPicker(orig, askDecision)
    const out = await wrapped()

    expect(orig).toHaveBeenCalledOnce()
    expect(askDecision).toHaveBeenCalledOnce()
    // Identity check — the site must receive the exact same array
    // reference the original picker returned.
    expect(out).toBe(handles)
  })

  it('sends METADATA ONLY (no File / Blob / bytes) to askDecision', async () => {
    const file = new File(['sensitive contents'], 'patient.pdf', {
      type: 'application/pdf',
    })
    const orig = vi.fn(() => Promise.resolve([fakeHandle(file)]))
    let captured: readonly FsaFileMetadata[] | null = null
    const askDecision = vi.fn((files: readonly FsaFileMetadata[]) => {
      captured = files
      return Promise.resolve<FsaDecision>('upload-anyway')
    })

    const wrapped = createWrappedPicker(orig, askDecision)
    await wrapped()

    expect(captured).not.toBeNull()
    expect(captured).toEqual([{ name: 'patient.pdf', size: file.size, type: 'application/pdf' }])
    // Belt-and-suspenders: no key other than name/size/type made it across.
    const entry = captured![0] as unknown as Record<string, unknown>
    expect(Object.keys(entry).sort()).toEqual(['name', 'size', 'type'])
  })

  it('throws AbortError when the decision is cancel — the exact DOMException the native picker throws', async () => {
    const orig = vi.fn(() =>
      Promise.resolve([fakeHandle(new File(['x'], 'a.pdf', { type: 'application/pdf' }))]),
    )
    const askDecision = vi.fn(() => Promise.resolve<FsaDecision>('cancel'))

    const wrapped = createWrappedPicker(orig, askDecision)

    let thrown: unknown = null
    try {
      await wrapped()
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(DOMException)
    expect((thrown as DOMException).name).toBe('AbortError')
    expect((thrown as DOMException).message).toBe('The user aborted a request.')
  })

  it('propagates a native cancel from the original picker without asking the isolated world', async () => {
    // If the user cancels the OS file dialog, `orig` throws AbortError.
    // The wrapper must not swallow it, must not send a hold-request,
    // and must let the site see the same AbortError it always saw.
    const nativeAbort = new DOMException('The user aborted a request.', 'AbortError')
    const orig = vi.fn(() => Promise.reject(nativeAbort))
    const askDecision = vi.fn(() => Promise.resolve<FsaDecision>('upload-anyway'))

    const wrapped = createWrappedPicker(orig, askDecision)

    await expect(wrapped()).rejects.toBe(nativeAbort)
    expect(askDecision).not.toHaveBeenCalled()
  })

  it('passes through when the picker returns an empty handle list without contacting the isolated world', async () => {
    const orig = vi.fn(() => Promise.resolve<FileHandleLike[]>([]))
    const askDecision = vi.fn(() => Promise.resolve<FsaDecision>('upload-anyway'))

    const wrapped = createWrappedPicker(orig, askDecision)
    const out = await wrapped()
    expect(out).toEqual([])
    expect(askDecision).not.toHaveBeenCalled()
  })

  it('forwards the picker options unchanged (types, multiple, excludeAcceptAllOption)', async () => {
    const orig = vi.fn(() =>
      Promise.resolve([fakeHandle(new File(['x'], 'a.pdf', { type: 'application/pdf' }))]),
    )
    const askDecision = vi.fn(() => Promise.resolve<FsaDecision>('upload-anyway'))

    const wrapped = createWrappedPicker(orig, askDecision)
    const opts = {
      multiple: true,
      types: [{ description: 'PDF', accept: { 'application/pdf': ['.pdf'] } }],
    }
    await wrapped(opts)
    expect(orig).toHaveBeenCalledWith(opts)
  })
})

describe('installFsaHook — double-wrap guard', () => {
  it('reports "installed" when showOpenFilePicker exists and is unwrapped', () => {
    ;(window as unknown as { showOpenFilePicker: unknown }).showOpenFilePicker = () =>
      Promise.resolve([])
    expect(installFsaHook(window)).toBe('installed')
  })

  it('reports "already-wrapped" on a second call, and does NOT re-wrap', () => {
    ;(window as unknown as { showOpenFilePicker: unknown }).showOpenFilePicker = () =>
      Promise.resolve([])
    installFsaHook(window)
    const wrappedOnce = (window as unknown as { showOpenFilePicker: unknown }).showOpenFilePicker
    expect(installFsaHook(window)).toBe('already-wrapped')
    // The wrapper reference must be unchanged — nested double-wrap
    // would defeat the AbortError semantics.
    expect((window as unknown as { showOpenFilePicker: unknown }).showOpenFilePicker).toBe(
      wrappedOnce,
    )
  })

  it('reports "unavailable" when the browser has no FSA support', () => {
    delete (window as unknown as { showOpenFilePicker?: unknown }).showOpenFilePicker
    expect(installFsaHook(window)).toBe('unavailable')
  })

  it('marks the wrapped function with __algWrapped = true', () => {
    ;(window as unknown as { showOpenFilePicker: unknown }).showOpenFilePicker = () =>
      Promise.resolve([])
    installFsaHook(window)
    const w = (window as unknown as { showOpenFilePicker: { __algWrapped?: boolean } })
      .showOpenFilePicker
    expect(w.__algWrapped).toBe(true)
  })
})
