// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  askIsolatedWorld,
  askOverPort,
  createWrappedPicker,
  FSA_HANDSHAKE_TIMEOUT_MS,
  installFsaHook,
  requestPort,
  __resetPortForTesting,
  type FileHandleLike,
} from '../src/content/main-world/fsa-hook'
import {
  FSA_HELLO_SOURCE,
  FSA_MESSAGE_SOURCE,
  FSA_PORT_HANDOFF_SOURCE,
  type FsaDecision,
  type FsaFileMetadata,
} from '../src/content/main-world/fsa-messages'

function fakeHandle(file: File): FileHandleLike {
  return { getFile: () => Promise.resolve(file) }
}

afterEach(() => {
  vi.restoreAllMocks()
  // Any test that installed on window must reset it.
  delete (window as unknown as { showOpenFilePicker?: unknown }).showOpenFilePicker
  __resetPortForTesting()
})

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

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

  it('sends metadata + the SAME File objects to askDecision (parallel arrays for the isolated inspector)', async () => {
    const file = new File(['sensitive contents'], 'patient.pdf', {
      type: 'application/pdf',
    })
    const orig = vi.fn(() => Promise.resolve([fakeHandle(file)]))
    let capturedMeta: readonly FsaFileMetadata[] | null = null
    let capturedBlobs: readonly File[] | null = null
    const askDecision = vi.fn((metadata: readonly FsaFileMetadata[], blobs: readonly File[]) => {
      capturedMeta = metadata
      capturedBlobs = blobs
      return Promise.resolve<FsaDecision>('upload-anyway')
    })

    const wrapped = createWrappedPicker(orig, askDecision)
    await wrapped()

    // Metadata still exactly {name,size,type}, no bytes.
    expect(capturedMeta).toEqual([
      { name: 'patient.pdf', size: file.size, type: 'application/pdf' },
    ])
    const metaEntry = capturedMeta![0] as unknown as Record<string, unknown>
    expect(Object.keys(metaEntry).sort()).toEqual(['name', 'size', 'type'])

    // Blobs are the actual File objects the picker returned — the
    // isolated inspector reads bytes from these on the private port.
    // In tests we get the SAME reference; in production the browser
    // hands the isolated world a structured-clone that shares the
    // underlying bytes.
    expect(capturedBlobs).not.toBeNull()
    expect(capturedBlobs!.length).toBe(1)
    expect(capturedBlobs![0]).toBeInstanceOf(File)
    expect(capturedBlobs![0]).toBe(file)
    // Blobs stay parallel to metadata.
    expect(capturedBlobs![0]?.name).toBe(capturedMeta![0]?.name)
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

describe('requestPort — hello / port-handoff handshake', () => {
  // The MAIN-world hook sends `alg-fsa-hello` and waits for the
  // isolated world to reply with `alg-fsa-port-handoff` carrying the
  // private port in its transfer list. These tests drive that flow
  // from the isolated side by capturing MAIN's hello and posting a
  // synthetic handoff.

  it('resolves with the port transferred on the port-handoff reply', async () => {
    // Kick off the request.
    const pending = requestPort(window, 'https://example')
    // Wait a microtask for the listener to attach and hello to post.
    await flush()
    // Simulate the isolated world's port-handoff arriving.
    const channel = new MessageChannel()
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { source: FSA_PORT_HANDOFF_SOURCE },
        source: window,
        origin: 'https://example',
        ports: [channel.port2],
      }),
    )
    const port = await pending
    expect(port).toBe(channel.port2)
    channel.port1.close()
    channel.port2.close()
  })

  it('sends alg-fsa-hello via window.postMessage on setup', async () => {
    const postSpy = vi.spyOn(window, 'postMessage').mockImplementation(() => {})
    void requestPort(window, 'https://example')
    await flush()
    const hellos = postSpy.mock.calls.filter(
      (c) =>
        typeof c[0] === 'object' &&
        c[0] !== null &&
        (c[0] as { source?: string }).source === FSA_HELLO_SOURCE,
    )
    expect(hellos.length).toBeGreaterThanOrEqual(1)
  })

  it('ignores port-handoff events from a different Window source', async () => {
    const pending = requestPort(window, 'https://example')
    await flush()
    const foreignChannel = new MessageChannel()
    const foreign = {} as unknown as Window
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { source: FSA_PORT_HANDOFF_SOURCE },
        source: foreign,
        origin: 'https://example',
        ports: [foreignChannel.port2],
      }),
    )
    // Give the listener a chance to reject.
    await flush()
    let resolved = false
    void pending.then(() => {
      resolved = true
    })
    await flush()
    expect(resolved).toBe(false)
    // Settle the pending promise with a valid same-window handoff so
    // the listener detaches and does not leak into subsequent tests.
    const realChannel = new MessageChannel()
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { source: FSA_PORT_HANDOFF_SOURCE },
        source: window,
        origin: 'https://example',
        ports: [realChannel.port2],
      }),
    )
    const settledPort = await pending
    expect(settledPort).toBe(realChannel.port2)
    foreignChannel.port1.close()
    foreignChannel.port2.close()
    realChannel.port1.close()
    realChannel.port2.close()
  })

  it('rejects with a timeout error when no port-handoff arrives', async () => {
    vi.useFakeTimers()
    try {
      const pending = requestPort(window, 'https://example')
      let err: unknown = null
      pending.catch((e) => {
        err = e
      })
      // Nothing dispatched → advance past the handshake timeout.
      vi.advanceTimersByTime(FSA_HANDSHAKE_TIMEOUT_MS + 1)
      // Let the rejection microtask flush.
      await Promise.resolve()
      await Promise.resolve()
      expect(err).toBeInstanceOf(Error)
      expect((err as Error).message).toContain('handshake timed out')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('askIsolatedWorld — fail-open on handshake failure', () => {
  it('resolves to upload-anyway when the isolated world never answers', async () => {
    vi.useFakeTimers()
    try {
      const promise = askIsolatedWorld(
        window,
        'https://example',
        [{ name: 'a.pdf', size: 1, type: 'application/pdf' }],
        [new File(['x'], 'a.pdf', { type: 'application/pdf' })],
      )
      vi.advanceTimersByTime(FSA_HANDSHAKE_TIMEOUT_MS + 1)
      // Drain microtasks for the caught rejection.
      await Promise.resolve()
      await Promise.resolve()
      const decision = await promise
      expect(decision).toBe('upload-anyway')
    } finally {
      vi.useRealTimers()
    }
  })

  it('does NOT cache a failed handshake — subsequent call gets a fresh attempt', async () => {
    vi.useFakeTimers()
    try {
      // First call fails.
      const first = askIsolatedWorld(window, 'https://example', [], [])
      vi.advanceTimersByTime(FSA_HANDSHAKE_TIMEOUT_MS + 1)
      await Promise.resolve()
      await Promise.resolve()
      await first

      // Second call — isolated world "wakes up" this time. The
      // handshake must happen fresh (not return a stale cached
      // failed promise). We verify by intercepting the outbound
      // hello and responding with a real port.
      vi.useRealTimers()
      const second = askIsolatedWorld(
        window,
        'https://example',
        [{ name: 'b.pdf', size: 1, type: 'application/pdf' }],
        [new File(['y'], 'b.pdf', { type: 'application/pdf' })],
      )
      // A microtask later, the hello has been posted; dispatch the
      // port-handoff.
      await flush()
      const channel = new MessageChannel()
      channel.port1.start()
      // Respond to the request over the port with an upload-anyway.
      channel.port1.onmessage = (event: MessageEvent) => {
        // Duck-type on kind + id (see fsa-messages.test.ts for the
        // full blob-shape validation; jsdom's structured clone drops
        // File so a full isFsaHoldRequest check would fail here).
        const d = event.data as { kind?: string; id?: string }
        if (d && d.kind === 'hold-request' && typeof d.id === 'string') {
          channel.port1.postMessage({
            source: 'alg-fsa',
            kind: 'hold-decision',
            id: d.id,
            decision: 'upload-anyway',
          })
        }
      }
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { source: 'alg-fsa-port-handoff' },
          source: window,
          origin: 'https://example',
          ports: [channel.port2],
        }),
      )
      const decision = await second
      expect(decision).toBe('upload-anyway')
      channel.port1.close()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('askOverPort — port-scoped hold-request / hold-decision', () => {
  it('sends a hold-request with the expected shape on the port and resolves with the matching decision', async () => {
    // In jsdom's MessageChannel implementation `File` does not survive
    // structured clone — reconstructed blobs come out as `{}` and
    // `isFsaHoldRequest` on the receiver would reject them. Real
    // Chrome clones `File` fine, so the shape is validated by
    // `tests/fsa-messages.test.ts` against an in-memory request; here
    // we only check the metadata half survives the round-trip.
    const channel = new MessageChannel()
    channel.port1.start()
    const decisionPromise = askOverPort(
      channel.port2,
      [{ name: 'a.pdf', size: 1, type: 'application/pdf' }],
      [new File(['x'], 'a.pdf', { type: 'application/pdf' })],
    )
    channel.port1.onmessage = (event: MessageEvent) => {
      const req = event.data as {
        source: string
        kind: string
        id: string
        files: readonly { name: string }[]
      }
      expect(req.source).toBe(FSA_MESSAGE_SOURCE)
      expect(req.kind).toBe('hold-request')
      expect(typeof req.id).toBe('string')
      expect(req.id.length).toBeGreaterThan(0)
      expect(req.files.map((f) => f.name)).toEqual(['a.pdf'])
      channel.port1.postMessage({
        source: FSA_MESSAGE_SOURCE,
        kind: 'hold-decision',
        id: req.id,
        decision: 'upload-anyway',
      })
    }
    channel.port2.start()
    const decision = await decisionPromise
    expect(decision).toBe('upload-anyway')
    channel.port1.close()
    channel.port2.close()
  })

  it('ignores decisions with a MISMATCHED id (concurrent pickers cannot cross wires)', async () => {
    const channel = new MessageChannel()
    channel.port1.start()
    channel.port2.start()
    // Capture the outbound request id first, then reply with a
    // MATCHING id (proves the promise resolves) after ensuring an
    // unrelated id was rejected.
    let capturedId: string | null = null
    channel.port1.onmessage = (event: MessageEvent) => {
      // Duck-type on kind + id (blob-shape validation happens against
      // an in-memory request in fsa-messages.test.ts; jsdom drops
      // structured-cloned Files, so the guard's blob check would fail
      // here on the receiver even though the wrapper posted a valid
      // request).
      const d = event.data as { kind?: string; id?: string }
      if (d && d.kind === 'hold-request' && typeof d.id === 'string') capturedId = d.id
    }
    const decisionPromise = askOverPort(
      channel.port2,
      [{ name: 'a.pdf', size: 1, type: 'application/pdf' }],
      [new File(['x'], 'a.pdf', { type: 'application/pdf' })],
    )
    for (let i = 0; i < 20 && capturedId === null; i++) await flush()
    expect(capturedId).not.toBeNull()

    // Post an unrelated decision — must be ignored.
    channel.port1.postMessage({
      source: FSA_MESSAGE_SOURCE,
      kind: 'hold-decision',
      id: 'not-our-id',
      decision: 'upload-anyway',
    })
    await flush()
    let settled = false
    void decisionPromise.then(() => {
      settled = true
    })
    await flush()
    expect(settled).toBe(false)

    // Now post the correct id — the promise resolves.
    channel.port1.postMessage({
      source: FSA_MESSAGE_SOURCE,
      kind: 'hold-decision',
      id: capturedId,
      decision: 'cancel',
    })
    const decision = await decisionPromise
    expect(decision).toBe('cancel')
    channel.port1.close()
    channel.port2.close()
  })

  it('does NOT observe hold-decisions posted via window.postMessage (adversarial regression)', async () => {
    // The core CodeRabbit CRITICAL scenario: after MAIN has sent a
    // hold-request over the port, a hostile page script forges a
    // matching hold-decision on window.postMessage. The wrapper must
    // not accept it — the listener is bound to the port, not to
    // window.
    const channel = new MessageChannel()
    channel.port1.start()
    channel.port2.start()
    // Capture the id MAIN uses so we can attempt a matching forgery.
    let capturedId: string | null = null
    channel.port1.onmessage = (event: MessageEvent) => {
      // Duck-type on kind + id (blob-shape validation happens against
      // an in-memory request in fsa-messages.test.ts; jsdom drops
      // structured-cloned Files, so the guard's blob check would fail
      // here on the receiver even though the wrapper posted a valid
      // request).
      const d = event.data as { kind?: string; id?: string }
      if (d && d.kind === 'hold-request' && typeof d.id === 'string') capturedId = d.id
    }
    const decisionPromise = askOverPort(
      channel.port2,
      [{ name: 'sensitive.pdf', size: 1, type: 'application/pdf' }],
      [new File(['x'], 'sensitive.pdf', { type: 'application/pdf' })],
    )
    // jsdom's MessageChannel dispatch timing isn't guaranteed on
    // one microtask flush — some environments (Node 24 in CI) need
    // a few event-loop turns before port1.onmessage fires. Poll
    // instead of asserting on a single flush.
    for (let i = 0; i < 20 && capturedId === null; i++) await flush()
    expect(capturedId).not.toBeNull()

    // Forge a decision with the observed id on window.postMessage.
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          source: FSA_MESSAGE_SOURCE,
          kind: 'hold-decision',
          id: capturedId,
          decision: 'upload-anyway',
        },
        source: window,
        origin: 'https://example',
      }),
    )
    await flush()

    let settled = false
    void decisionPromise.then(() => {
      settled = true
    })
    await flush()
    expect(settled).toBe(false)

    // Sanity check: a REAL decision posted on the port DOES resolve
    // the same promise, proving the port channel is live and the
    // forgery was rejected specifically because it came from window.
    channel.port1.postMessage({
      source: FSA_MESSAGE_SOURCE,
      kind: 'hold-decision',
      id: capturedId,
      decision: 'cancel',
    })
    const decision = await decisionPromise
    expect(decision).toBe('cancel')
    channel.port1.close()
    channel.port2.close()
  })
})
