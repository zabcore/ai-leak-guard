// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  handleFsaHoldRequest,
  installFsaMessageHandler,
  type FsaHandlerDeps,
} from '../src/content/fsa-isolated'
import {
  FSA_HELLO_SOURCE,
  FSA_MESSAGE_SOURCE,
  isFsaHoldDecision,
  isFsaPortHandoff,
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

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

// Perform the MAIN-side of the handshake and return the transferred
// port. Uses postMessage-with-transfer as the browser does. The
// handoff message is dispatched by the isolated handler onto the
// window; we spy on `window.postMessage` to catch its ports arg.
async function performHandshake(): Promise<MessagePort> {
  return await new Promise<MessagePort>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no port-handoff arrived')), 500)
    // Capture the port off the outbound postMessage that the isolated
    // handler makes when it receives our hello.
    const originalPost = window.postMessage.bind(window)
    vi.spyOn(window, 'postMessage').mockImplementation((...args: unknown[]) => {
      const [data, _origin, transfer] = args as [unknown, string, Transferable[] | undefined]
      if (isFsaPortHandoff(data) && Array.isArray(transfer) && transfer[0] instanceof MessagePort) {
        clearTimeout(timer)
        const port = transfer[0]
        port.start()
        resolve(port)
        return
      }
      originalPost(data as never, _origin as never)
    })
    // Dispatch the hello as if it came from MAIN world (same window
    // = same source).
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { source: FSA_HELLO_SOURCE },
        source: window,
        origin: 'https://example',
      }),
    )
  })
}

describe('handleFsaHoldRequest — decision routing via the reply seam', () => {
  it('flag OFF → replies upload-anyway without calling showModal', async () => {
    const showModal = vi.fn(() => Promise.resolve<'upload-anyway' | 'cancel'>('cancel'))
    const reply = vi.fn()
    await handleFsaHoldRequest(
      holdRequest([{ name: 'a.pdf', size: 1, type: 'application/pdf' }]),
      makeDeps({ isActive: () => false, showModal }),
      reply,
    )
    expect(reply).toHaveBeenCalledTimes(1)
    expect(reply).toHaveBeenCalledWith('upload-anyway')
    expect(showModal).not.toHaveBeenCalled()
  })

  it('another modal already open → replies cancel (drop-on-the-floor)', async () => {
    const showModal = vi.fn()
    const reply = vi.fn()
    await handleFsaHoldRequest(
      holdRequest([{ name: 'a.pdf', size: 1, type: 'application/pdf' }]),
      makeDeps({ isAnotherModalOpen: () => true, showModal }),
      reply,
    )
    expect(reply).toHaveBeenCalledTimes(1)
    expect(reply).toHaveBeenCalledWith('cancel')
    expect(showModal).not.toHaveBeenCalled()
  })

  it('flag ON + no other modal → opens the modal and forwards the outcome', async () => {
    const showModal: FsaHandlerDeps['showModal'] = vi.fn(() =>
      Promise.resolve<'upload-anyway' | 'cancel'>('upload-anyway'),
    )
    const reply = vi.fn()
    await handleFsaHoldRequest(
      holdRequest([{ name: 'a.pdf', size: 1, type: 'application/pdf' }]),
      makeDeps({ showModal }),
      reply,
    )
    expect(reply).toHaveBeenCalledTimes(1)
    expect(reply).toHaveBeenCalledWith('upload-anyway')
    const mock = showModal as unknown as ReturnType<typeof vi.fn>
    expect(mock).toHaveBeenCalledOnce()
    const call = mock.mock.calls[0] as [{ fileCount: number }]
    expect(call[0]).toEqual({ fileCount: 1 })
  })
})

describe('installFsaMessageHandler — private-channel handshake & round-trip', () => {
  it('transfers a MessagePort on the first alg-fsa-hello', async () => {
    uninstall = installFsaMessageHandler(window, makeDeps())
    const port = await performHandshake()
    expect(port).toBeInstanceOf(MessagePort)
    port.close()
  })

  it('ignores hellos with a foreign source tag — no port handed out', async () => {
    uninstall = installFsaMessageHandler(window, makeDeps())
    const postSpy = vi.spyOn(window, 'postMessage').mockImplementation(() => {})
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { source: 'not-us' },
        source: window,
        origin: 'https://example',
      }),
    )
    await flush()
    const handoffs = postSpy.mock.calls.filter((c) => isFsaPortHandoff(c[0]))
    expect(handoffs).toHaveLength(0)
  })

  it('ignores hellos whose source is a different Window (cross-frame)', async () => {
    uninstall = installFsaMessageHandler(window, makeDeps())
    const postSpy = vi.spyOn(window, 'postMessage').mockImplementation(() => {})
    const foreign = {} as unknown as Window
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { source: FSA_HELLO_SOURCE },
        source: foreign,
        origin: 'https://example',
      }),
    )
    await flush()
    const handoffs = postSpy.mock.calls.filter((c) => isFsaPortHandoff(c[0]))
    expect(handoffs).toHaveLength(0)
  })

  it('only ever hands out the port once (subsequent hellos are dropped)', async () => {
    uninstall = installFsaMessageHandler(window, makeDeps())
    const port = await performHandshake()
    // Clear performHandshake's spy so window.postMessage is native
    // again and the second hello's response (if any) actually fires a
    // real message event we can observe via a plain listener.
    vi.restoreAllMocks()
    let secondHandoffs = 0
    const seen = (event: MessageEvent): void => {
      if (isFsaPortHandoff(event.data)) secondHandoffs += 1
    }
    window.addEventListener('message', seen)
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { source: FSA_HELLO_SOURCE },
        source: window,
        origin: 'https://example',
      }),
    )
    await flush()
    window.removeEventListener('message', seen)
    expect(secondHandoffs).toBe(0)
    port.close()
  })

  it('replies to a valid hold-request on the port with a matching id and forwarded decision', async () => {
    uninstall = installFsaMessageHandler(
      window,
      makeDeps({ showModal: () => Promise.resolve('upload-anyway') }),
    )
    const port = await performHandshake()
    const req = holdRequest([{ name: 'a.pdf', size: 1, type: 'application/pdf' }])
    const decision = await new Promise<{ id: string; decision: string }>((resolve) => {
      port.addEventListener('message', (event) => {
        if (isFsaHoldDecision(event.data)) resolve(event.data as { id: string; decision: string })
      })
      port.postMessage(req)
    })
    expect(decision.id).toBe(req.id)
    expect(decision.decision).toBe('upload-anyway')
    port.close()
  })

  it('IGNORES a malformed hold-request on the port — no reply, no modal', async () => {
    const showModal = vi.fn()
    uninstall = installFsaMessageHandler(window, makeDeps({ showModal }))
    const port = await performHandshake()
    const seen: unknown[] = []
    port.addEventListener('message', (event) => seen.push(event.data))
    port.postMessage({ source: FSA_MESSAGE_SOURCE, kind: 'hold-request', id: 'x' /* no files */ })
    await flush()
    expect(seen).toHaveLength(0)
    expect(showModal).not.toHaveBeenCalled()
    port.close()
  })

  it('replies cancel when showModal throws — the wrapper then throws AbortError, mirroring native cancel', async () => {
    const showModal = vi.fn(() => Promise.reject(new Error('modal blew up')))
    uninstall = installFsaMessageHandler(window, makeDeps({ showModal }))
    const port = await performHandshake()
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const req = holdRequest([{ name: 'a.pdf', size: 1, type: 'application/pdf' }])
    const decision = await new Promise<{ decision: string }>((resolve) => {
      port.addEventListener('message', (event) => {
        if (isFsaHoldDecision(event.data)) resolve(event.data as { decision: string })
      })
      port.postMessage(req)
    })
    expect(decision.decision).toBe('cancel')
    expect(errSpy).toHaveBeenCalled()
    port.close()
  })
})

describe('installFsaMessageHandler — adversarial regression (CodeRabbit CRITICAL)', () => {
  // Before the MessageChannel refactor, a page script could observe a
  // `hold-request` (posted via `window.postMessage`), copy its id,
  // and post a matching forged `hold-decision` back on `window` — the
  // MAIN-world wrapper accepted it as valid and resolved
  // `upload-anyway` without the modal ever opening. After the
  // refactor, hold-requests and hold-decisions travel on a
  // transferred `MessagePort`; a `window.postMessage` decision is
  // inert because the wrapper's listener is attached to the port,
  // not to window.
  //
  // These tests assert BOTH sides of that guarantee:
  //   1. The isolated handler does NOT respond to hold-requests
  //      that arrive over `window.postMessage`.
  //   2. A forged hold-decision on `window.postMessage` does not
  //      influence anything on the port.

  it('ignores a hold-request posted over window.postMessage (must arrive on the port)', async () => {
    const showModal = vi.fn()
    uninstall = installFsaMessageHandler(window, makeDeps({ showModal }))
    // Complete the handshake so we're in the steady state.
    const port = await performHandshake()
    // Now forge a hold-request via window.postMessage — this is
    // exactly what a hostile page script would try.
    const postSpy = vi.spyOn(window, 'postMessage').mockImplementation(() => {})
    let portGotAnyMessage = false
    port.addEventListener('message', () => {
      portGotAnyMessage = true
    })
    window.dispatchEvent(
      new MessageEvent('message', {
        data: holdRequest([{ name: 'evil.pdf', size: 1, type: 'application/pdf' }]),
        source: window,
        origin: 'https://example',
      }),
    )
    await flush()
    expect(showModal).not.toHaveBeenCalled()
    expect(portGotAnyMessage).toBe(false)
    expect(postSpy.mock.calls.filter((c) => isFsaHoldDecision(c[0]))).toHaveLength(0)
    port.close()
  })
})
