// V1.2 A5.1 manifest permission delta test.
//
// The activity page + local export explicitly declare NO new
// permissions. Blob downloads work with `URL.createObjectURL` +
// `<a download>` — the `downloads` permission is NOT required
// and is NOT requested. `options_ui` is a page-config field, not
// a permission. This test guards those invariants so a future
// well-meaning edit (e.g. "let's add downloads for cleaner UX")
// can't sneak past the review.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

interface Manifest {
  permissions?: readonly string[]
  // `optional_permissions` and `optional_host_permissions` are
  // dormant grants — Chrome can ask the user for them at runtime.
  // A future well-meaning edit that declared, say,
  // `optional_permissions: ['downloads']` would expand the
  // extension's permission surface without failing the existing
  // required-list checks. This test refuses either declaration
  // to keep the permission story exactly what the docs promise.
  optional_permissions?: readonly string[]
  host_permissions?: readonly string[]
  optional_host_permissions?: readonly string[]
  options_ui?: { page?: string; open_in_tab?: boolean }
  action?: { default_popup?: string }
  content_scripts?: readonly unknown[]
  background?: { service_worker?: string }
}

const manifest = JSON.parse(readFileSync(resolve('manifest.json'), 'utf8')) as Manifest

describe('manifest — A5.1 + Teams Lite (#78) permission delta', () => {
  it('permissions list is exactly ["storage", "alarms"] — no `downloads` or anything else', () => {
    // #78 adds `alarms` (and ONLY `alarms`) for the enrolled check-in
    // scheduler. It carries no data and does nothing on the Free path (the
    // alarm handler is a no-op unless enrolled). Everything else is still
    // forbidden so a well-meaning edit can't sneak past review.
    expect(manifest.permissions).toEqual(['storage', 'alarms'])
    expect(manifest.permissions ?? []).not.toContain('downloads')
    expect(manifest.permissions ?? []).not.toContain('activeTab')
    expect(manifest.permissions ?? []).not.toContain('tabs')
    expect(manifest.permissions ?? []).not.toContain('scripting')
    // Same story for optional permissions — a declared-but-not-
    // yet-requested `downloads` (or `activeTab`, `tabs`, etc.)
    // still expands the manifest's permission surface as far as
    // the Chrome Web Store review is concerned. Reject any
    // declaration outright rather than allowlisting specific
    // values, so a novel permission we didn't think of can't
    // slip in either.
    expect(manifest.optional_permissions ?? []).toEqual([])
    expect(manifest.optional_host_permissions ?? []).toEqual([])
  })

  it('host_permissions are the AI tool sites + the Teams Lite backend (local supabase for the dev demo)', () => {
    // The AI-site origins are unchanged. #78 adds the local `supabase functions
    // serve` origins so the ENROLLED check-in fetch is permitted for the M1
    // dev demo; a real deployment's project origin is appended at build time
    // from VITE_TEAMS_BASE_URL (see vite.config.ts). `permissions` stays narrow;
    // no blanket wildcards.
    expect(manifest.host_permissions).toEqual([
      'https://chatgpt.com/*',
      'https://chat.openai.com/*',
      'https://claude.ai/*',
      'https://gemini.google.com/*',
      'https://www.perplexity.ai/*',
      'https://copilot.microsoft.com/*',
      'https://copilot.cloud.microsoft/*',
      'http://127.0.0.1:54321/*',
      'http://localhost:54321/*',
    ])
  })

  it('declares options_ui pointing at the activity page in a new tab', () => {
    expect(manifest.options_ui).toBeDefined()
    expect(manifest.options_ui?.page).toBe('src/popup/activity.html')
    // `open_in_tab: true` gives us a full-viewport page instead of
    // the cramped embedded options iframe.
    expect(manifest.options_ui?.open_in_tab).toBe(true)
  })
})
