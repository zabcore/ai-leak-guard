// V1.3.3 Onboarding — every extension → website link carries a content-free
// source label so the future website can attribute the entry point. These pin
// the helper's shape and that it never leaks anything but the fixed enum label.

import { describe, expect, it } from 'vitest'
import {
  withLinkSource,
  LINK_SOURCES,
  LINK_SOURCE_PARAM,
  type LinkSource,
} from '../src/shared/link-source'

describe('withLinkSource', () => {
  it('appends the alg_src label, preserving existing params', () => {
    const out = withLinkSource('https://zabcore.com/welcome?utm_campaign=x&v=1.3.3', 'welcome')
    const u = new URL(out)
    expect(u.searchParams.get(LINK_SOURCE_PARAM)).toBe('welcome')
    expect(u.searchParams.get('utm_campaign')).toBe('x')
    expect(u.searchParams.get('v')).toBe('1.3.3')
  })

  it('supports the three defined labels', () => {
    expect([...LINK_SOURCES]).toEqual(['welcome', 'popup', 'test-complete'])
    for (const source of LINK_SOURCES) {
      expect(
        new URL(withLinkSource('https://zabcore.com/x', source)).searchParams.get('alg_src'),
      ).toBe(source)
    }
  })

  it('replaces an existing label rather than duplicating it', () => {
    const once = withLinkSource('https://zabcore.com/x', 'welcome')
    const twice = withLinkSource(once, 'popup' as LinkSource)
    const params = new URL(twice).searchParams.getAll(LINK_SOURCE_PARAM)
    expect(params).toEqual(['popup'])
  })

  it('carries only the fixed label — no user data in the param', () => {
    // The type system already forbids arbitrary strings; this documents intent.
    const out = withLinkSource('https://zabcore.com/welcome', 'welcome')
    expect(out).toContain('alg_src=welcome')
  })
})
