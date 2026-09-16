// V1.3.3 Onboarding — source labels for extension → website links.
//
// Every link the EXTENSION opens to the marketing website carries one
// content-free source label so the (future, Track-A) website can attribute the
// entry point — which extension surface sent the user — without any user data
// ever leaving the device. This is an inert hook: the website reads the param;
// the extension only stamps it. No network request is made here (the welcome
// tab is a `chrome.tabs.create` navigation, not a fetch).
//
// The label is a fixed enum, NEVER interpolated from anything the user typed.

export const LINK_SOURCES = ['welcome', 'popup', 'test-complete'] as const
export type LinkSource = (typeof LINK_SOURCES)[number]

/** The query param carrying the source label. */
export const LINK_SOURCE_PARAM = 'alg_src'

/**
 * Append (or replace) the content-free `alg_src` source label on a website URL.
 * Uses the URL API (available in the service worker and the popup) so existing
 * params are preserved. Throws only on a malformed base URL — callers pass
 * literal, trusted bases.
 */
export function withLinkSource(url: string, source: LinkSource): string {
  const u = new URL(url)
  u.searchParams.set(LINK_SOURCE_PARAM, source)
  return u.toString()
}
