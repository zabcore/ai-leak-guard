import type { SiteAdapter } from './base'
import chatgpt from './chatgpt'
import claude from './claude'
import gemini from './gemini'
import perplexity from './perplexity'
import copilot from './copilot'
import fallback from './fallback'

export const ADAPTERS: readonly SiteAdapter[] = [
  chatgpt,
  claude,
  gemini,
  perplexity,
  copilot,
] as const

/**
 * Returns the adapter whose `domains` list includes the current hostname.
 * Returns the fallback adapter if none match.
 */
export function getAdapterForHost(hostname: string): SiteAdapter {
  const host = hostname.toLowerCase()
  for (const adapter of ADAPTERS) {
    if (adapter.domains.includes(host)) return adapter
  }
  return fallback
}

export type { SiteAdapter }
export { fallback }
