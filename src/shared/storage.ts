// Thin wrapper over chrome.storage.local. Implemented in a later issue.
export async function getValue<T>(_key: string): Promise<T | null> {
  return null
}

export async function setValue<T>(_key: string, _value: T): Promise<void> {
  return
}
