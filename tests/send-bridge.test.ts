// @vitest-environment jsdom
//
// V1.3.5 — the isolated-world side of the Enter-reclaim bridge. Proves it arms
// the shim (posts ready), answers a shim hello with ready, and runs onSendIntent
// for a send-intent — but ignores unrelated/foreign messages.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { installSendBridge, probeShimInterception } from '../src/content/submit/send-bridge'
import {
  helloMessage,
  sendIntentMessage,
  selfTestProbeResult,
  isSelfTestProbe,
  isSendReady,
} from '../src/content/main-world/send-messages'

let remove: (() => void) | null = null

// jsdom does not set MessageEvent.source for window.postMessage, so deliver
// inbound messages with an explicit source (matching the FSA test convention).
function deliver(data: unknown): void {
  window.dispatchEvent(new MessageEvent('message', { data, source: window, origin: window.origin }))
}

afterEach(() => {
  remove?.()
  remove = null
  vi.restoreAllMocks()
})

async function tick(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
}

describe('installSendBridge', () => {
  it('posts ready on install (arms a waiting shim)', async () => {
    const seen: unknown[] = []
    const capture = (e: MessageEvent): void => void seen.push(e.data)
    window.addEventListener('message', capture)

    remove = installSendBridge({ onSendIntent: () => {}, origin: window.origin })
    await tick()
    expect(seen.some(isSendReady)).toBe(true)

    window.removeEventListener('message', capture)
  })

  it('replies to a shim hello with ready', async () => {
    const readyPosts: unknown[] = []
    const capture = (e: MessageEvent): void => {
      if (isSendReady(e.data)) readyPosts.push(e.data)
    }
    remove = installSendBridge({ onSendIntent: () => {}, origin: window.origin })
    await tick()
    window.addEventListener('message', capture)

    deliver(helloMessage)
    await tick()
    expect(readyPosts.length).toBeGreaterThanOrEqual(1)

    window.removeEventListener('message', capture)
  })

  it('runs onSendIntent for a send-intent message', async () => {
    const onSendIntent = vi.fn()
    remove = installSendBridge({ onSendIntent, origin: window.origin })
    await tick()

    deliver(sendIntentMessage)
    await tick()
    expect(onSendIntent).toHaveBeenCalledTimes(1)
  })

  it('ignores unrelated messages', async () => {
    const onSendIntent = vi.fn()
    remove = installSendBridge({ onSendIntent, origin: window.origin })
    await tick()

    deliver({ source: 'something-else', kind: 'send-intent' })
    deliver({ hello: 'world' })
    await tick()
    expect(onSendIntent).not.toHaveBeenCalled()
  })

  it('a throwing onSendIntent never escapes the message pump', async () => {
    const onSendIntent = vi.fn(() => {
      throw new Error('boom')
    })
    remove = installSendBridge({ onSendIntent, origin: window.origin })
    await tick()
    expect(() => {
      deliver(sendIntentMessage)
    }).not.toThrow()
    await tick()
    expect(onSendIntent).toHaveBeenCalledTimes(1)
  })
})

describe('probeShimInterception', () => {
  it('posts a probe and resolves TRUE on a blocked:true reply', async () => {
    // Stand in for the shim: on a probe, reply blocked:true.
    const shim = (e: MessageEvent): void => {
      if (isSelfTestProbe(e.data)) {
        window.dispatchEvent(
          new MessageEvent('message', {
            data: selfTestProbeResult(true),
            source: window,
            origin: window.origin,
          }),
        )
      }
    }
    window.addEventListener('message', shim)
    const result = await probeShimInterception({ origin: window.origin, timeoutMs: 500 })
    expect(result).toBe(true)
    window.removeEventListener('message', shim)
  })

  it('resolves FALSE on a blocked:false reply (shim lost the race)', async () => {
    const shim = (e: MessageEvent): void => {
      if (isSelfTestProbe(e.data)) {
        window.dispatchEvent(
          new MessageEvent('message', {
            data: selfTestProbeResult(false),
            source: window,
            origin: window.origin,
          }),
        )
      }
    }
    window.addEventListener('message', shim)
    const result = await probeShimInterception({ origin: window.origin, timeoutMs: 500 })
    expect(result).toBe(false)
    window.removeEventListener('message', shim)
  })

  it('resolves FALSE on timeout when no shim answers (disabled/absent → not confirmed)', async () => {
    const result = await probeShimInterception({ origin: window.origin, timeoutMs: 30 })
    expect(result).toBe(false)
  })
})
