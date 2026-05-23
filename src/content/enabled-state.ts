// Resolves the initial enabled flag from stored preferences. Fails closed: if
// the preference can't be read, the extension stays inactive rather than
// assuming it should mask. No DOM or Chrome APIs here so it stays testable.
export async function resolveInitialEnabled(
  read: () => Promise<{ enabled: boolean }>,
): Promise<boolean> {
  try {
    const prefs = await read()
    return prefs.enabled
  } catch {
    return false
  }
}

export interface EnabledState {
  isEnabled: () => boolean
  /** Apply the initial storage read — ignored once a live update has arrived. */
  applyInitial: (value: boolean) => void
  /** Apply a live storage.onChanged update; always wins over the initial read. */
  applyLiveUpdate: (value: boolean) => void
}

// The initial storage read is async, so a storage.onChanged event (e.g. the user
// toggling the popup during startup) can arrive before it resolves. A live
// update must win: once one has been seen, the stale initial read is ignored.
export function createEnabledState(initial = false): EnabledState {
  let enabled = initial
  let hasReceivedLiveUpdate = false

  return {
    isEnabled: () => enabled,
    applyInitial: (value) => {
      if (!hasReceivedLiveUpdate) enabled = value
    },
    applyLiveUpdate: (value) => {
      hasReceivedLiveUpdate = true
      enabled = value
    },
  }
}
