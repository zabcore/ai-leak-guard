// V1.3.3 Live Gate C — persistence for the per-route status store.
//
// Thin filesystem I/O kept OUT of `route-status.ts` so the store/expiry logic
// stays pure and browser-free for unit tests. The status file is uploaded as a
// workflow artifact and carried across scheduled runs (see the workflow's
// cache step) so the 36 h expiry and consecutive-pass streak span runs.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { RouteStatusMap } from './route-status'

/** Load the status map, or an empty map if the file is absent/unreadable. */
export function loadStatus(path: string): RouteStatusMap {
  try {
    if (!existsSync(path)) return {}
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? (parsed as RouteStatusMap) : {}
  } catch {
    // A corrupt store must not read as green: start empty (every required
    // route then reads "no run recorded" → not ready).
    return {}
  }
}

/** Write the status map (pretty-printed, stable key order) to `path`. */
export function saveStatus(path: string, map: RouteStatusMap): void {
  mkdirSync(dirname(path), { recursive: true })
  const ordered: RouteStatusMap = {}
  for (const key of Object.keys(map).sort()) ordered[key] = map[key]
  writeFileSync(path, JSON.stringify(ordered, null, 2) + '\n', 'utf8')
}
