// V1.3.3 Onboarding — dismissible in-popup nudge memory (local only).
//
// An inert hook for the future (Track-A) in-popup registration/update nudge:
// the extension remembers, in `chrome.storage.local`, that the user chose
// "Not now" (snooze) or "Don't ask again" (never) for a given prompt id, so the
// site can add the nudge later without another extension release.
//
// INVARIANTS (enforced by construction + documented for callers):
//   • Metadata only — a prompt id, a choice, and a timestamp. NEVER any user
//     data or page content.
//   • Popup-only — these nudges live in the extension action popup, a surface
//     entirely separate from the in-page warning modals, so a nudge can never
//     interrupt a real sensitive-data warning.
//   • No auto-enrollment — dismissal state gates DISPLAY only; nothing here
//     enrolls the user in anything.
//
// Pure data logic (no chrome APIs) so it is unit-tested directly; the
// `chrome.storage.local` wrappers live in `storage.ts`.

export type PromptDismissal = 'later' | 'never'

export interface PromptState {
  readonly kind: PromptDismissal
  /** ISO-8601 (or epoch ms) of the dismissal — used to expire a "later". */
  readonly at: number
}

export type PromptMemory = Record<string, PromptState>

/** "Not now" snoozes a prompt for this long before it may show again. */
export const DEFAULT_LATER_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

/** Record a dismissal choice for `id`. Pure — returns the next memory map. */
export function recordDismissal(
  memory: PromptMemory,
  id: string,
  kind: PromptDismissal,
  at: number,
): PromptMemory {
  return { ...memory, [id]: { kind, at } }
}

/**
 * Whether the prompt `id` may be shown now. Unseen → yes. "Don't ask again"
 * (`never`) → never again. "Not now" (`later`) → not until the cooldown lapses.
 */
export function shouldShowPrompt(
  memory: PromptMemory,
  id: string,
  now: number,
  laterCooldownMs: number = DEFAULT_LATER_COOLDOWN_MS,
): boolean {
  const state = memory[id]
  if (state === undefined) return true
  if (state.kind === 'never') return false
  return now - state.at >= laterCooldownMs
}
