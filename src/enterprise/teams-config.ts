// Teams Lite — backend configuration from BUILD-TIME env (one shared build).
//
// `VITE_TEAMS_BASE_URL`  — the Supabase functions base URL (e.g.
//                          http://127.0.0.1:54321 in dev, the project URL in prod).
// `VITE_TEAMS_ANON_KEY`  — the Supabase ANON (publishable) key. PUBLIC — safe to
//                          ship in the extension. The SERVICE-ROLE key MUST NEVER
//                          appear here or anywhere in the extension; it lives only
//                          in the edge-function server environment.
//
// An unconfigured build (neither set) has no backend: `getBackendConfig()`
// returns null and the enrollment path reports `not_configured` — it never
// calls anything. Reading env here is inert (no network); the `fetch` lives only
// in `teams-client.ts`, which the free path never dynamically imports.

export interface TeamsBackendConfig {
  /** Base URL with any trailing slash trimmed. */
  readonly baseUrl: string
  /** Supabase anon (public) key — sent as `apikey` + `Authorization: Bearer`. */
  readonly anonKey: string
}

export function getBackendConfig(): TeamsBackendConfig | null {
  const env = import.meta.env ?? {}
  const baseUrl = (env.VITE_TEAMS_BASE_URL ?? '').trim().replace(/\/+$/, '')
  const anonKey = (env.VITE_TEAMS_ANON_KEY ?? '').trim()
  if (baseUrl === '' || anonKey === '') return null
  return { baseUrl, anonKey }
}
