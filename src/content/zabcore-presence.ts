// Teams Lite (deployment m1) — the bridge/1.1.0 presence hint (checklist C3).
//
// Injected ONLY on https://zabcore.com/join* (top frame). Once the page has
// loaded it posts exactly
//   { ns: "zc.join", v: 1, type: "cs_presence", payload: { ext_version } }
// to the zabcore origin, so the join page knows the extension is installed
// before it opens the `zc.join.v1` port. That is all it does: no listener, no
// storage, no network, nothing secret — the join itself happens over the port.

export const PRESENCE_ORIGIN = 'https://zabcore.com'
export const PRESENCE_PATH_PREFIX = '/join'

export interface PresenceHint {
  readonly ns: 'zc.join'
  readonly v: 1
  readonly type: 'cs_presence'
  readonly payload: { readonly ext_version: string }
}

export function presenceHint(extVersion: string): PresenceHint {
  return { ns: 'zc.join', v: 1, type: 'cs_presence', payload: { ext_version: extVersion } }
}

/**
 * Post the hint once, on load (immediately if the page already finished
 * loading). Returns false — and posts nothing — anywhere but the top frame of
 * an apex `/join*` page, whatever the manifest matched.
 */
export function announcePresence(win: Window, extVersion: string): boolean {
  if (win.location.origin !== PRESENCE_ORIGIN) return false
  if (!win.location.pathname.startsWith(PRESENCE_PATH_PREFIX)) return false
  if (win.top !== win) return false
  const post = (): void => win.postMessage(presenceHint(extVersion), PRESENCE_ORIGIN)
  if (win.document.readyState === 'complete') post()
  else win.addEventListener('load', post, { once: true })
  return true
}

const runtime = (globalThis as { chrome?: typeof chrome }).chrome?.runtime
if (typeof window !== 'undefined' && typeof runtime?.getManifest === 'function') {
  announcePresence(window, runtime.getManifest().version)
}
