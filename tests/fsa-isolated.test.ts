// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  handleFsaHoldRequest,
  installFsaMessageHandler,
  type FsaHandlerDeps,
} from '../src/content/fsa-isolated'
import type { FileInspection } from '../src/content/file-inspector'
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

// Cheap fake inspection — enough to satisfy the FileInspection shape
// so the handler runs to the modal. Individual tests can override.
function fakeInspection(files: readonly File[]): FileInspection {
  const perFile = files.map((file) => ({
    meta: { file, name: file.name, size: file.size, type: file.type },
    extraction: {
      status: 'extracted' as const,
      text: '',
      meta: {
        name: file.name,
        size: file.size,
        type: file.type,
        detectedFormat: 'text' as const,
      },
    },
    findings: [],
    scan: {
      state: 'clean' as const,
      maskableCount: 0,
      categories: [],
      hasCriticalOrHigh: false,
    },
  }))
  return {
    perFile,
    aggregate: {
      state: 'clean' as const,
      totalMaskable: 0,
      categories: [],
      anyCriticalOrHigh: false,
      perStateCounts: { sensitive: 0, clean: files.length, unable: 0 },
    },
  }
}

function makeDeps(overrides: Partial<FsaHandlerDeps> = {}): FsaHandlerDeps {
  return {
    isActive: overrides.isActive ?? (() => true),
    isAnotherModalOpen: overrides.isAnotherModalOpen ?? (() => false),
    // Stub the shared decision helper so tests don't need the
    // real Shadow-DOM modal running under jsdom.
    resolveDecision: overrides.resolveDecision ?? (() => Promise.resolve('cancel')),
    // Stub inspection by default so tests avoid pdf.js lazy-loads
    // and jsdom quirks. Individual tests can pass their own to
    // observe the argument or force a delay.
    inspect: overrides.inspect ?? ((files) => Promise.resolve(fakeInspection(files))),
  }
}

function holdRequest(files: { name: string; size: number; type: string }[] = []): FsaHoldRequest {
  return {
    source: FSA_MESSAGE_SOURCE,
    kind: 'hold-request',
    id: 'test-id-1',
    files,
    blobs: files.map((f) => new File(['x'], f.name, { type: f.type })),
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
  it('flag OFF → replies upload-anyway without calling resolveDecision', async () => {
    const resolveDecision = vi.fn(() => Promise.resolve<'upload-anyway' | 'cancel'>('cancel'))
    const reply = vi.fn()
    await handleFsaHoldRequest(
      holdRequest([{ name: 'a.pdf', size: 1, type: 'application/pdf' }]),
      makeDeps({ isActive: () => false, resolveDecision }),
      reply,
    )
    expect(reply).toHaveBeenCalledTimes(1)
    expect(reply).toHaveBeenCalledWith('upload-anyway')
    expect(resolveDecision).not.toHaveBeenCalled()
  })

  it('another modal already open → replies cancel (drop-on-the-floor)', async () => {
    const resolveDecision = vi.fn()
    const reply = vi.fn()
    await handleFsaHoldRequest(
      holdRequest([{ name: 'a.pdf', size: 1, type: 'application/pdf' }]),
      makeDeps({ isAnotherModalOpen: () => true, resolveDecision }),
      reply,
    )
    expect(reply).toHaveBeenCalledTimes(1)
    expect(reply).toHaveBeenCalledWith('cancel')
    expect(resolveDecision).not.toHaveBeenCalled()
  })

  it('flag ON + no other modal → routes through resolveDecision and forwards the outcome', async () => {
    // Typed via the seam's own signature — Vitest 4.x infers
    // `mock.calls` from the supplied function type.
    const resolveDecision = vi.fn<FsaHandlerDeps['resolveDecision']>(() =>
      Promise.resolve<'upload-anyway' | 'cancel'>('upload-anyway'),
    )
    const reply = vi.fn()
    await handleFsaHoldRequest(
      holdRequest([{ name: 'a.pdf', size: 1, type: 'application/pdf' }]),
      makeDeps({ resolveDecision }),
      reply,
    )
    expect(reply).toHaveBeenCalledTimes(1)
    expect(reply).toHaveBeenCalledWith('upload-anyway')
    expect(resolveDecision).toHaveBeenCalledOnce()
    const [pendingInspection, opts] = resolveDecision.mock.calls[0]
    // The FSA path passes a pending inspection promise (not a
    // resolved value) so the decision helper can race it against
    // the flicker delay.
    expect(pendingInspection).toBeInstanceOf(Promise)
    const inspection = await pendingInspection
    expect(inspection.aggregate.state).toBe('clean')
    expect(inspection.perFile).toHaveLength(1)
    // No opener element from the FSA path — the picker was invoked
    // by the page's own JS; there's no editor to return focus to.
    expect(opts).toEqual({ opener: null })
  })

  it('flag OFF → does NOT run inspection (bytes are not touched on the pass-through path)', async () => {
    const inspect = vi.fn(() => Promise.resolve(fakeInspection([])))
    const resolveDecision = vi.fn(() => Promise.resolve<'upload-anyway' | 'cancel'>('cancel'))
    const reply = vi.fn()
    await handleFsaHoldRequest(
      holdRequest([{ name: 'a.pdf', size: 1, type: 'application/pdf' }]),
      makeDeps({ isActive: () => false, inspect, resolveDecision }),
      reply,
    )
    expect(inspect).not.toHaveBeenCalled()
    expect(reply).toHaveBeenCalledWith('upload-anyway')
  })

  it('another modal already open → does NOT run inspection either', async () => {
    const inspect = vi.fn(() => Promise.resolve(fakeInspection([])))
    const resolveDecision = vi.fn()
    const reply = vi.fn()
    await handleFsaHoldRequest(
      holdRequest([{ name: 'a.pdf', size: 1, type: 'application/pdf' }]),
      makeDeps({ isAnotherModalOpen: () => true, inspect, resolveDecision }),
      reply,
    )
    expect(inspect).not.toHaveBeenCalled()
    expect(reply).toHaveBeenCalledWith('cancel')
  })

  it('A3.1: inspect() is called with the request.blobs (File[]) so extraction + detection can run', async () => {
    const inspect = vi.fn((files: readonly File[]) => Promise.resolve(fakeInspection(files)))
    const resolveDecision = vi.fn(() =>
      Promise.resolve<'upload-anyway' | 'cancel'>('upload-anyway'),
    )
    const reply = vi.fn()
    const req = holdRequest([{ name: 'a.pdf', size: 1, type: 'application/pdf' }])
    await handleFsaHoldRequest(req, makeDeps({ inspect, resolveDecision }), reply)
    expect(inspect).toHaveBeenCalledOnce()
    const passedFiles = inspect.mock.calls[0]?.[0] as readonly File[]
    // Same reference the request carried — no marshalling loss.
    expect(passedFiles).toBe(req.blobs)
    expect(passedFiles[0]).toBeInstanceOf(File)
    expect(reply).toHaveBeenCalledWith('upload-anyway')
  })
})

describe('handleFsaHoldRequest — parity with the change / drop / paste path', () => {
  // A3.1 closed the coverage gap where the FSA picker never scanned.
  // Both the change/drop/paste path (document-flow) and the FSA path
  // funnel through the SAME `inspectFiles` — this test locks that in
  // by running the real inspector on the same File and asserting the
  // FSA handler produces byte-for-byte the same inspection.
  it('same File via the FSA hold-request scans identically to the change-path (paste-path parity)', async () => {
    const { inspectFiles } = await import('../src/content/file-inspector')
    const text = 'Patient SSN: 123-45-6789 in the record.'
    const file = new File([text], 'sensitive.txt', { type: 'text/plain' })

    // Reference: what the change/drop/paste path sees today.
    const reference = await inspectFiles([file])

    // FSA path: drive the handler with NO `inspect` override so the
    // real `inspectFiles` runs from `request.blobs`. The decision
    // helper is stubbed so we can observe the pending inspection
    // promise the handler hands it.
    let observed: FileInspection | null = null
    const resolveDecision = async (
      inspectionPromise: Promise<FileInspection>,
      _opts: { opener: Element | null },
    ): Promise<'upload-anyway' | 'cancel'> => {
      observed = await inspectionPromise
      return 'cancel'
    }
    // Use holdRequest's metadata but override its dummy blob with the
    // real File so the two paths see the same bytes.
    const req: FsaHoldRequest = {
      source: FSA_MESSAGE_SOURCE,
      kind: 'hold-request',
      id: 'parity-1',
      files: [{ name: file.name, size: file.size, type: file.type }],
      blobs: [file],
    }
    await handleFsaHoldRequest(
      req,
      {
        isActive: () => true,
        isAnotherModalOpen: () => false,
        resolveDecision,
        // no `inspect` — use production `inspectFiles`
      },
      () => {},
    )

    expect(observed).not.toBeNull()
    const fsa = observed!
    // Aggregate parity.
    expect(fsa.aggregate.state).toBe(reference.aggregate.state)
    expect(fsa.aggregate.totalMaskable).toBe(reference.aggregate.totalMaskable)
    expect(fsa.aggregate.anyCriticalOrHigh).toBe(reference.aggregate.anyCriticalOrHigh)
    expect([...fsa.aggregate.categories].sort()).toEqual([...reference.aggregate.categories].sort())
    // Per-file finding parity — same rules, spans, values, sensitivity.
    const norm = (fs: readonly { ruleId: string; start: number; end: number; value: string }[]) =>
      fs.map((f) => `${f.ruleId}|${f.start}|${f.end}|${f.value}`).sort()
    expect(norm([...fsa.perFile[0].findings])).toEqual(norm([...reference.perFile[0].findings]))
    // And it actually found something (belt & suspenders — otherwise
    // parity would be trivially satisfied by two empty lists).
    expect(fsa.perFile[0].findings.length).toBeGreaterThanOrEqual(1)
    expect(fsa.aggregate.state).toBe('sensitive')
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
      makeDeps({ resolveDecision: () => Promise.resolve('upload-anyway') }),
    )
    const port = await performHandshake()
    // Empty picker so the round-trip through jsdom's MessageChannel
    // doesn't need to preserve File objects (jsdom's structured
    // clone drops File — see comment in fsa-hook.test.ts). The
    // handler's decision routing is what this test locks in.
    const req = holdRequest([])
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
    const resolveDecision = vi.fn()
    uninstall = installFsaMessageHandler(window, makeDeps({ resolveDecision }))
    const port = await performHandshake()
    const seen: unknown[] = []
    port.addEventListener('message', (event) => seen.push(event.data))
    port.postMessage({ source: FSA_MESSAGE_SOURCE, kind: 'hold-request', id: 'x' /* no files */ })
    await flush()
    expect(seen).toHaveLength(0)
    expect(resolveDecision).not.toHaveBeenCalled()
    port.close()
  })

  it('replies cancel when resolveDecision throws — the wrapper then throws AbortError, mirroring native cancel', async () => {
    const resolveDecision = vi.fn(() => Promise.reject(new Error('decision blew up')))
    uninstall = installFsaMessageHandler(window, makeDeps({ resolveDecision }))
    const port = await performHandshake()
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    // Empty picker — see note in the "replies to a valid hold-request"
    // test above; jsdom's MessageChannel drops File on clone.
    const req = holdRequest([])
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
    const resolveDecision = vi.fn()
    uninstall = installFsaMessageHandler(window, makeDeps({ resolveDecision }))
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
    expect(resolveDecision).not.toHaveBeenCalled()
    expect(portGotAnyMessage).toBe(false)
    expect(postSpy.mock.calls.filter((c) => isFsaHoldDecision(c[0]))).toHaveLength(0)
    port.close()
  })

  // First-hello-hijack: a hostile page script races the MAIN hook by
  // posting `alg-fsa-hello` before our hook does. `MessagePort`
  // transfer is one-shot, so whichever `message` listener reads
  // `event.ports[0]` on the port-handoff first claims the port,
  // starving the real MAIN hook. This is the fundamental
  // realm-sharing limitation documented in `docs/ARCHITECTURE.md` —
  // this test locks in the current behavior so any future
  // authenticated-handshake work is exercised by a regression check.
  //
  // jsdom's `window.postMessage` doesn't reliably transfer
  // `MessagePort` objects across same-window listeners the way a
  // real browser does, so we assert on the isolated handler's OWN
  // postMessage calls (captured via spy) rather than on port
  // delivery: the handler posts a handoff with a port on the FIRST
  // valid hello and does NOT post a second handoff on a later hello.
  it('current-behavior: only one hello is answered with a port; a second hello is ignored', async () => {
    uninstall = installFsaMessageHandler(window, makeDeps())
    const handoffCalls: Array<{ transferHadPort: boolean }> = []
    vi.spyOn(window, 'postMessage').mockImplementation((...args: unknown[]) => {
      const [data, , transfer] = args as [unknown, string, Transferable[] | undefined]
      if (isFsaPortHandoff(data)) {
        handoffCalls.push({
          transferHadPort: Array.isArray(transfer) && transfer[0] instanceof MessagePort,
        })
      }
    })

    // First hello (from whoever wins the race — hostile or hook).
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { source: FSA_HELLO_SOURCE },
        source: window,
        origin: 'https://example',
      }),
    )
    await flush()
    expect(handoffCalls).toHaveLength(1)
    expect(handoffCalls[0].transferHadPort).toBe(true)

    // Second hello (the loser trying to reach the port).
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { source: FSA_HELLO_SOURCE },
        source: window,
        origin: 'https://example',
      }),
    )
    await flush()
    // Still only one handoff. The one-shot port has been transferred
    // and the loser gets nothing — MAIN's bounded handshake timeout
    // (see `fsa-hook.ts` FSA_HANDSHAKE_TIMEOUT_MS) fails open to
    // `upload-anyway`, matching the warn-don't-block invariant.
    expect(handoffCalls).toHaveLength(1)
  })
})
