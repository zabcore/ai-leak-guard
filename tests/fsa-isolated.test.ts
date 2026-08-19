// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  handleFsaHoldRequest,
  installFsaMessageHandler,
  type FsaHandlerDeps,
} from '../src/content/fsa-isolated'
import {
  FSA_MESSAGE_SOURCE,
  isFsaHoldDecision,
  type FsaHoldRequest,
} from '../src/content/main-world/fsa-messages'

let uninstall: (() => void) | null = null

afterEach(() => {
  uninstall?.()
  uninstall = null
  vi.restoreAllMocks()
})

function makeDeps(overrides: Partial<FsaHandlerDeps> = {}): FsaHandlerDeps {
  return {
    isActive: overrides.isActive ?? (() => true),
    isAnotherModalOpen: overrides.isAnotherModalOpen ?? (() => false),
    showModal: overrides.showModal ?? (() => Promise.resolve('cancel')),
  }
}

function holdRequest(files: { name: string; size: number; type: string }[] = []): FsaHoldRequest {
  return {
    source: FSA_MESSAGE_SOURCE,
    kind: 'hold-request',
    id: 'test-id-1',
    files,
  }
}

// The messaging tests use `postMessage` to send fake messages into
// the same window. jsdom dispatches `message` events on window for
// same-window postMessage in a microtask, so tests await a small
// tick to observe the reply.
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('handleFsaHoldRequest — direct decision routing', () => {
  it('flag OFF → replies upload-anyway without calling showModal', async () => {
    const showModal = vi.fn(() => Promise.resolve<'upload-anyway' | 'cancel'>('cancel'))
    const postSpy = vi.spyOn(window, 'postMessage').mockImplementation(() => {})
    await handleFsaHoldRequest(
      window,
      holdRequest([{ name: 'a.pdf', size: 1, type: 'application/pdf' }]),
      makeDeps({ isActive: () => false, showModal }),
    )
    const decisions = postSpy.mock.calls
      .map((call) => call[0])
      .filter((d): d is { decision: string } => isFsaHoldDecision(d))
    expect(decisions.length).toBe(1)
    expect(decisions[0].decision).toBe('upload-anyway')
    expect(showModal).not.toHaveBeenCalled()
  })

  it('another modal already open → replies cancel (drop-on-the-floor)', async () => {
    const showModal = vi.fn()
    const postSpy = vi.spyOn(window, 'postMessage').mockImplementation(() => {})
    await handleFsaHoldRequest(
      window,
      holdRequest([{ name: 'a.pdf', size: 1, type: 'application/pdf' }]),
      makeDeps({ isAnotherModalOpen: () => true, showModal }),
    )
    const decisions = postSpy.mock.calls
      .map((call) => call[0])
      .filter((d): d is { decision: string } => isFsaHoldDecision(d))
    expect(decisions.length).toBe(1)
    expect(decisions[0].decision).toBe('cancel')
    expect(showModal).not.toHaveBeenCalled()
  })

  it('flag ON + no other modal → opens the modal and forwards the outcome', async () => {
    const showModal: FsaHandlerDeps['showModal'] = vi.fn(() =>
      Promise.resolve<'upload-anyway' | 'cancel'>('upload-anyway'),
    )
    const postSpy = vi.spyOn(window, 'postMessage').mockImplementation(() => {})
    await handleFsaHoldRequest(
      window,
      holdRequest([{ name: 'a.pdf', size: 1, type: 'application/pdf' }]),
      makeDeps({ showModal }),
    )
    const decisions = postSpy.mock.calls
      .map((call) => call[0])
      .filter((d): d is { decision: string } => isFsaHoldDecision(d))
    expect(decisions.length).toBe(1)
    expect(decisions[0].decision).toBe('upload-anyway')
    const mock = showModal as unknown as ReturnType<typeof vi.fn>
    expect(mock).toHaveBeenCalledOnce()
    const call = mock.mock.calls[0] as [{ fileCount: number }]
    expect(call[0]).toEqual({ fileCount: 1 })
  })
})

describe('installFsaMessageHandler — end-to-end messaging round-trip', () => {
  // jsdom same-window `postMessage` origin behavior is finicky in
  // some environments, so these tests inject inbound messages by
  // constructing a MessageEvent with `source: window` and dispatching
  // it on window (which is exactly what the browser does for a real
  // same-window postMessage) and observe the outbound reply via a
  // spy on `window.postMessage`. This is what the production handler
  // actually sees / calls.

  function injectHoldRequest(data: unknown): void {
    const event = new MessageEvent('message', { data, source: window, origin: 'https://example' })
    window.dispatchEvent(event)
  }

  it('replies to a valid hold-request with a matching id and forwarded decision', async () => {
    const postSpy = vi.spyOn(window, 'postMessage').mockImplementation(() => {})
    uninstall = installFsaMessageHandler(
      window,
      makeDeps({ showModal: () => Promise.resolve('upload-anyway') }),
    )
    const req = holdRequest([{ name: 'a.pdf', size: 1, type: 'application/pdf' }])
    injectHoldRequest(req)
    await flush()
    const replies = postSpy.mock.calls
      .map((call) => call[0])
      .filter((d): d is { source: string; kind: string; id: string; decision: string } =>
        isFsaHoldDecision(d),
      )
    expect(replies.length).toBe(1)
    expect(replies[0].id).toBe(req.id)
    expect(replies[0].decision).toBe('upload-anyway')
  })

  it('IGNORES a foreign message (wrong source tag) — no reply, no modal', async () => {
    const showModal = vi.fn()
    const postSpy = vi.spyOn(window, 'postMessage').mockImplementation(() => {})
    uninstall = installFsaMessageHandler(window, makeDeps({ showModal }))
    injectHoldRequest({ source: 'not-us', kind: 'hold-request', id: 'x', files: [] })
    await flush()
    expect(postSpy.mock.calls.filter((c) => isFsaHoldDecision(c[0]))).toHaveLength(0)
    expect(showModal).not.toHaveBeenCalled()
  })

  it('IGNORES a malformed message (missing files array) — no reply, no modal', async () => {
    const showModal = vi.fn()
    const postSpy = vi.spyOn(window, 'postMessage').mockImplementation(() => {})
    uninstall = installFsaMessageHandler(window, makeDeps({ showModal }))
    injectHoldRequest({ source: FSA_MESSAGE_SOURCE, kind: 'hold-request', id: 'x' })
    await flush()
    expect(postSpy.mock.calls.filter((c) => isFsaHoldDecision(c[0]))).toHaveLength(0)
    expect(showModal).not.toHaveBeenCalled()
  })

  it('IGNORES a message whose `source` is another Window (e.g. a cross-frame post)', async () => {
    const showModal = vi.fn()
    const postSpy = vi.spyOn(window, 'postMessage').mockImplementation(() => {})
    uninstall = installFsaMessageHandler(window, makeDeps({ showModal }))
    // A fake "other window" — the handler must reject because
    // event.source !== window.
    const foreignSource = {} as unknown as Window
    window.dispatchEvent(
      new MessageEvent('message', {
        data: holdRequest([{ name: 'a.pdf', size: 1, type: 'application/pdf' }]),
        source: foreignSource,
        origin: 'https://example',
      }),
    )
    await flush()
    expect(postSpy.mock.calls.filter((c) => isFsaHoldDecision(c[0]))).toHaveLength(0)
    expect(showModal).not.toHaveBeenCalled()
  })

  it('replies cancel when showModal throws — the wrapper then throws AbortError, mirroring native cancel', async () => {
    const showModal = vi.fn(() => Promise.reject(new Error('modal blew up')))
    const postSpy = vi.spyOn(window, 'postMessage').mockImplementation(() => {})
    uninstall = installFsaMessageHandler(window, makeDeps({ showModal }))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const req = holdRequest([{ name: 'a.pdf', size: 1, type: 'application/pdf' }])
    injectHoldRequest(req)
    await flush()
    const replies = postSpy.mock.calls
      .map((call) => call[0])
      .filter((d): d is { decision: string } => isFsaHoldDecision(d))
    expect(replies.length).toBe(1)
    expect(replies[0].decision).toBe('cancel')
    expect(errSpy).toHaveBeenCalled()
  })
})
