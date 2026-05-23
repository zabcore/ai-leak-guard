import type { Finding } from '../detector/types'
import type { SiteAdapter } from './adapters/base'
import { decrementCounters } from '../shared/counter'

// Restores the original pasted text and only rolls back the counter when the
// editor actually accepted the restoration. If replaceContents fails, the
// editor still shows the masked text, so decrementing would desync the counter
// from reality — we leave it as-is and warn instead.
export async function undoMask(
  adapter: SiteAdapter,
  target: Element,
  originalText: string,
  findings: Finding[],
): Promise<void> {
  const restored = adapter.replaceContents(target, originalText)
  if (!restored) {
    console.warn(
      '[AI Leak Guard] Undo failed: replaceContents returned false; leaving the counter unchanged to avoid desyncing it from the editor.',
    )
    return
  }
  await decrementCounters(findings)
}
