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
