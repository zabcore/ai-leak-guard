// V1.3.4 — the `#alg-selftest` hash trigger (the SECOND way into the guided
// self-test, alongside the popup signal). These are the pure orchestration
// tests: hash matching, the strict run-once guard, URL cleanup, and the
// top-frame guard — the actual run is injected, so nothing heavy loads here.

import { describe, expect, it, vi } from 'vitest'
import {
  hashRequestsSelfTest,
  createHashSelfTestTrigger,
  SELF_TEST_HASH,
} from '../src/content/submit/self-test-hash'

describe('hashRequestsSelfTest', () => {
  it('matches the bare token', () => {
    expect(hashRequestsSelfTest('#alg-selftest')).toBe(true)
    expect(SELF_TEST_HASH).toBe('#alg-selftest')
  })

  it('is case-insensitive', () => {
    expect(hashRequestsSelfTest('#ALG-SELFTEST')).toBe(true)
    expect(hashRequestsSelfTest('#Alg-SelfTest')).toBe(true)
  })

  it('ignores trailing junk after the token', () => {
    expect(hashRequestsSelfTest('#alg-selftest?src=web')).toBe(true)
    expect(hashRequestsSelfTest('#alg-selftest/')).toBe(true)
    expect(hashRequestsSelfTest('#alg-selftest=1')).toBe(true)
    expect(hashRequestsSelfTest('#alg-selftest ')).toBe(true)
    expect(hashRequestsSelfTest('#alg-selftest&x=y')).toBe(true)
  })

  it('does NOT match when the token is only a prefix of a longer word', () => {
    // The token must END on a non [a-z0-9-] boundary so an unrelated longer
    // hash cannot trip it.
    expect(hashRequestsSelfTest('#alg-selftesting')).toBe(false)
    expect(hashRequestsSelfTest('#alg-selftest-foo')).toBe(false)
  })

  it('does NOT match unrelated or empty hashes', () => {
    expect(hashRequestsSelfTest('')).toBe(false)
    expect(hashRequestsSelfTest('#')).toBe(false)
    expect(hashRequestsSelfTest('#settings')).toBe(false)
    expect(hashRequestsSelfTest('#alg')).toBe(false)
    expect(hashRequestsSelfTest('#/alg-selftest')).toBe(false)
  })
})

describe('createHashSelfTestTrigger', () => {
  const topFrame = () => true

  it('on a matching hash: strips the URL then runs, exactly once', () => {
    const run = vi.fn()
    const stripHash = vi.fn()
    const t = createHashSelfTestTrigger({
      getHash: () => '#alg-selftest',
      stripHash,
      run,
      isTopFrame: topFrame,
    })
    t.check()
    expect(stripHash).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledTimes(1)
    expect(t.hasStarted()).toBe(true)
    // The strip happens BEFORE the run (so a re-render during the run can't
    // re-trigger off a still-present token).
    expect(stripHash.mock.invocationCallOrder[0]).toBeLessThan(run.mock.invocationCallOrder[0])
  })

  it('run-once: two checks (initial load + a repeated hashchange) run it once', () => {
    const run = vi.fn()
    const stripHash = vi.fn()
    // The hash stays present (simulating a listener that fires again before the
    // strip is observed) — the started guard, not the strip, is the guarantee.
    const t = createHashSelfTestTrigger({
      getHash: () => '#alg-selftest',
      stripHash,
      run,
      isTopFrame: topFrame,
    })
    t.check()
    t.check()
    t.check()
    expect(run).toHaveBeenCalledTimes(1)
    expect(stripHash).toHaveBeenCalledTimes(1)
  })

  it('does nothing on a non-matching hash (never strips, never runs)', () => {
    const run = vi.fn()
    const stripHash = vi.fn()
    const t = createHashSelfTestTrigger({
      getHash: () => '#something-else',
      stripHash,
      run,
      isTopFrame: topFrame,
    })
    t.check()
    expect(run).not.toHaveBeenCalled()
    expect(stripHash).not.toHaveBeenCalled()
    expect(t.hasStarted()).toBe(false)
  })

  it('is a no-op outside the top frame (a sub-frame must not consume it)', () => {
    const run = vi.fn()
    const stripHash = vi.fn()
    const t = createHashSelfTestTrigger({
      getHash: () => '#alg-selftest',
      stripHash,
      run,
      isTopFrame: () => false,
    })
    t.check()
    expect(run).not.toHaveBeenCalled()
    expect(stripHash).not.toHaveBeenCalled()
    expect(t.hasStarted()).toBe(false)
  })

  it('a later navigation to the token is ignored once a run has started', () => {
    const run = vi.fn()
    let hash = '#alg-selftest'
    const t = createHashSelfTestTrigger({
      getHash: () => hash,
      stripHash: () => {
        hash = ''
      },
      run,
      isTopFrame: topFrame,
    })
    t.check() // matches → runs
    hash = '#alg-selftest' // user navigates back to the token
    t.check() // must stay a no-op
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('a run that throws still leaves the trigger consumed (no retry loop)', () => {
    const run = vi.fn(() => {
      throw new Error('boom')
    })
    const t = createHashSelfTestTrigger({
      getHash: () => '#alg-selftest',
      stripHash: () => {},
      run,
      isTopFrame: topFrame,
    })
    expect(() => t.check()).toThrow('boom')
    // started was set before run() was invoked, so a subsequent check is a
    // no-op rather than re-running the failed synthetic test.
    t.check()
    expect(run).toHaveBeenCalledTimes(1)
  })
})
