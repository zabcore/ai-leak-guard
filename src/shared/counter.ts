import type { Finding } from '../detector/types'
import { getCounters, setCounters } from './storage'

// Bucket by the user's *local* calendar day, not UTC, so "today" in the popup
// matches the user's wall clock.
export function localDateKey(date: Date = new Date()): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

// Serialize all counter writes through a single promise chain so concurrent
// pastes can't clobber each other's read-modify-write and lose updates.
let writeChain: Promise<void> = Promise.resolve()

function enqueueWrite(op: () => Promise<void>): Promise<void> {
  const result = writeChain.then(op)
  // Keep the chain alive even if one op rejects.
  writeChain = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

export async function incrementCounters(findings: Finding[]): Promise<void> {
  if (findings.length === 0) return

  // Diagnostic logging (BUG C): confirms the increment runs and the write lands.
  console.log(`[AI Leak Guard] incrementCounters: recording ${findings.length} finding(s)`)
  try {
    await enqueueWrite(async () => {
      const counters = await getCounters()
      const day = localDateKey()
      for (const finding of findings) {
        counters.total += 1
        counters.byType[finding.ruleId] = (counters.byType[finding.ruleId] ?? 0) + 1
        counters.byDay[day] = (counters.byDay[day] ?? 0) + 1
      }
      await setCounters(counters)
      console.log(
        `[AI Leak Guard] counters persisted: total=${counters.total}, today(${day})=${counters.byDay[day]}`,
      )
    })
  } catch (err) {
    console.warn(
      '[AI Leak Guard] Failed to persist the leak counter after masking; the count may be inaccurate.',
      err,
    )
  }
}

export async function decrementCounters(findings: Finding[]): Promise<void> {
  if (findings.length === 0) return

  try {
    await enqueueWrite(async () => {
      const counters = await getCounters()
      const day = localDateKey()
      for (const finding of findings) {
        counters.total = Math.max(0, counters.total - 1)
        counters.byType[finding.ruleId] = Math.max(0, (counters.byType[finding.ruleId] ?? 0) - 1)
        counters.byDay[day] = Math.max(0, (counters.byDay[day] ?? 0) - 1)
      }
      await setCounters(counters)
    })
  } catch (err) {
    console.warn(
      '[AI Leak Guard] Failed to persist the leak counter after undo; the count may be inaccurate.',
      err,
    )
  }
}
