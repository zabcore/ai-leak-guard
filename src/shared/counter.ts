import type { Finding } from '../detector/types'
import { getCounters, setCounters } from './storage'

function todayKey(): string {
  return new Date().toISOString().slice(0, 10)
}

export async function incrementCounters(findings: Finding[]): Promise<void> {
  if (findings.length === 0) return

  const counters = await getCounters()
  const day = todayKey()
  for (const finding of findings) {
    counters.total += 1
    counters.byType[finding.ruleId] = (counters.byType[finding.ruleId] ?? 0) + 1
    counters.byDay[day] = (counters.byDay[day] ?? 0) + 1
  }
  await setCounters(counters)
}

export async function decrementCounters(findings: Finding[]): Promise<void> {
  if (findings.length === 0) return

  const counters = await getCounters()
  const day = todayKey()
  for (const finding of findings) {
    counters.total = Math.max(0, counters.total - 1)
    counters.byType[finding.ruleId] = Math.max(0, (counters.byType[finding.ruleId] ?? 0) - 1)
    counters.byDay[day] = Math.max(0, (counters.byDay[day] ?? 0) - 1)
  }
  await setCounters(counters)
}
