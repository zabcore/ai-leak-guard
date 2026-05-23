import { getCounters, getPrefs, setPrefs } from '../shared/storage'

function todayKey(): string {
  return new Date().toISOString().slice(0, 10)
}

function setToggleLabel(enabled: boolean): void {
  const label = document.getElementById('toggle-label')
  if (label !== null) label.textContent = enabled ? 'Enabled' : 'Disabled'
}

async function render(): Promise<void> {
  const [counters, prefs] = await Promise.all([getCounters(), getPrefs()])

  const total = document.getElementById('total')
  const today = document.getElementById('today')
  const toggle = document.getElementById('toggle')

  if (total !== null) total.textContent = String(counters.total)
  if (today !== null) today.textContent = String(counters.byDay[todayKey()] ?? 0)
  if (toggle instanceof HTMLInputElement) toggle.checked = prefs.enabled
  setToggleLabel(prefs.enabled)
}

async function init(): Promise<void> {
  // Render initial state from storage BEFORE wiring the change listener so the
  // programmatic checked-state assignment can't be observed as a user change.
  await render()

  const toggle = document.getElementById('toggle')
  if (toggle instanceof HTMLInputElement) {
    toggle.addEventListener('change', () => {
      setToggleLabel(toggle.checked)
      void setPrefs({ enabled: toggle.checked })
    })
  }
}

document.addEventListener('DOMContentLoaded', () => {
  void init()
})
