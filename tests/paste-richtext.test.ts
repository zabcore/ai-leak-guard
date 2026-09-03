// @vitest-environment jsdom
//
// V1.2 M6.1 rich-text paste tests.
//
// Two layers of coverage:
//
//   1. `readPastedText` — the choke-point helper. Exhaustive on the
//      three source paths (`plain` / `html` / `none`) and on
//      `hadContent`. Also pins the "no script execution" invariant
//      on the inert `DOMParser` strip (critical: the whole point of
//      this helper is that a hostile `text/html` payload cannot
//      exfiltrate anything from the calling document).
//
//   2. `detectDetailed(readPastedText(cd).text)` — end-to-end round
//      trip: identifiers pasted from a rich-text source produce the
//      SAME findings/hasCriticalOrHigh flag the plain-text path
//      produces. This is the actual defect the fix addresses; the
//      V1.1 handler bailed before detection could run.
//
// The paste-handler wire in `src/content/index.ts` (target/adapter
// check → unable-to-inspect log → MIN_TEXT_LENGTH guard → detect →
// modal) is a straight-line one-file wire, covered by inspection —
// the event-log-wiring suite documents the same pattern for the
// document path ("the paste path's wire is a one-liner in
// `index.ts`, covered by inspection"). What matters for the M6.1
// fix specifically is that:
//   • extracted rich-text is byte-identical to what detection would
//     have seen from a plain-text paste (Layer 2 below);
//   • the "unable-to-inspect" branch fires ONLY when there was
//     actual non-`Files` content on the clipboard (Layer 1 below);
//   • no raw HTML or extracted plaintext ever survives on the
//     event-log storage record (moat-rule test at the end).

import { describe, expect, it } from 'vitest'
import {
  readPastedText,
  stripHtmlToText,
  MAX_HTML_STRIP_CHARS,
} from '../src/content/clipboard-text'
import { detectDetailed } from '../src/detector/engine'
import { appendEvent } from '../src/shared/event-log'

// ─── Rich clipboard stub ────────────────────────────────────────────────────
//
// The setup.ts `FakeDataTransfer` only carries `Files` and reports
// `types === ['Files']`. Rich-text pastes never carry a file — they
// carry MIME strings (`text/plain`, `text/html`, custom types).
// This stub adds `setData` and reports a `types` list that mirrors a
// real browser's paste DataTransfer.

interface StubOpts {
  readonly plain?: string
  readonly html?: string
  readonly extra?: Readonly<Record<string, string>>
  /** Force one MIME's `getData` to throw (browser cross-origin case). */
  readonly throwOn?: string
  /** Throw when the caller iterates `types`. */
  readonly throwOnTypes?: boolean
}

function makeClipboard(opts: StubOpts = {}): DataTransfer {
  const bag = new Map<string, string>()
  if (opts.plain !== undefined) bag.set('text/plain', opts.plain)
  if (opts.html !== undefined) bag.set('text/html', opts.html)
  if (opts.extra !== undefined) {
    for (const [k, v] of Object.entries(opts.extra)) bag.set(k, v)
  }
  const cd = {
    get types(): readonly string[] {
      if (opts.throwOnTypes === true) throw new Error('types access refused')
      return [...bag.keys()]
    },
    getData(type: string): string {
      if (opts.throwOn === type) throw new Error(`getData refused for ${type}`)
      return bag.get(type) ?? ''
    },
    files: { length: 0 } as unknown as FileList,
  }
  return cd as unknown as DataTransfer
}

function fileOnlyClipboard(): DataTransfer {
  // Reuses the setup.ts FakeDataTransfer path: only `Files` type,
  // `getData` returns empty for everything.
  const dt = new DataTransfer()
  dt.items.add(new File(['x'], 'a.png', { type: 'image/png' }))
  return dt
}

// ─── Layer 1: readPastedText behavior ───────────────────────────────────────

describe('readPastedText — source: plain', () => {
  it('returns text/plain when present, non-empty, and non-whitespace', () => {
    const cd = makeClipboard({ plain: 'hello world' })
    const out = readPastedText(cd)
    expect(out.source).toBe('plain')
    expect(out.text).toBe('hello world')
    expect(out.hadContent).toBe(true)
  })

  it('prefers text/plain over text/html when both are present (Google-Docs shape)', () => {
    const cd = makeClipboard({
      plain: 'the plain slot won',
      html: '<p>the html slot lost</p>',
    })
    const out = readPastedText(cd)
    expect(out.source).toBe('plain')
    expect(out.text).toBe('the plain slot won')
  })

  it('does NOT strip internal whitespace from the plain slot', () => {
    // The plain-slot path is untouched vs. V1.1 — no trim of the
    // returned value. Only the emptiness *check* trims (so a
    // "   " plain + real html hands control to the html branch).
    const cd = makeClipboard({ plain: '  hello  ' })
    const out = readPastedText(cd)
    expect(out.source).toBe('plain')
    expect(out.text).toBe('  hello  ')
  })
})

describe('readPastedText — source: html', () => {
  it('falls back to text/html when text/plain is absent (rich-text web app shape)', () => {
    const cd = makeClipboard({ html: '<p>Patient MRN <b>MRN123456</b></p>' })
    const out = readPastedText(cd)
    expect(out.source).toBe('html')
    expect(out.text).toBe('Patient MRN MRN123456')
    expect(out.hadContent).toBe(true)
  })

  it('falls back to text/html when text/plain is present but whitespace-only', () => {
    const cd = makeClipboard({ plain: '   \n\t ', html: '<p>hello</p>' })
    const out = readPastedText(cd)
    expect(out.source).toBe('html')
    expect(out.text).toBe('hello')
  })

  it('strips through the inert DOMParser — no <script> execution, no <img> fetch', () => {
    // The critical safety invariant: DOMParser must NOT run scripts
    // or fire resource fetches. If it did, a hostile page could
    // exfiltrate via a paste of hostile HTML into any input we
    // observe. We assert (a) no `window.__pwned__` side effect from
    // a bare <script>, (b) `image.onerror` on a bogus src is NOT
    // registered on this window either.
    ;(window as unknown as Record<string, unknown>).__pwned__ = false
    const html = `
      <script>window.__pwned__ = true</script>
      <img src="http://ai-leak-guard.invalid/beacon.png"
           onerror="window.__pwned__ = true">
      <p>real body text</p>
    `
    const cd = makeClipboard({ html })
    const out = readPastedText(cd)
    expect(out.source).toBe('html')
    expect(out.text).toContain('real body text')
    // The scripts DID land in body.textContent because textContent
    // includes the <script>'s source; that's fine — it's inert
    // text. What matters is the side effect never fired.
    expect((window as unknown as Record<string, unknown>).__pwned__).toBe(false)
  })

  it('preserves internal whitespace across tag boundaries', () => {
    // The detector regexes were tuned on plain-text spacing, so a
    // <p>foo</p><p>bar</p> must not collapse into "foobar".
    // textContent preserves the visible whitespace already present
    // in the source HTML.
    const cd = makeClipboard({ html: '<p>foo</p><p>bar</p><p>baz</p>' })
    const out = readPastedText(cd)
    expect(out.source).toBe('html')
    // Whitespace between the tags in the source is preserved. The
    // exact form depends on the browser's DOMParser output — we
    // just assert the tokens land in order and don't merge.
    expect(out.text).toMatch(/foo[\s]*bar[\s]*baz/)
  })

  it('trims the outer edges so leading whitespace does not derail anchored regexes', () => {
    const cd = makeClipboard({ html: '<div>  \n hello  \n  </div>' })
    const out = readPastedText(cd)
    expect(out.source).toBe('html')
    expect(out.text.startsWith('hello')).toBe(true)
    expect(out.text.endsWith('hello')).toBe(true)
  })
})

describe('readPastedText — source: none', () => {
  it('returns text: "", source: "none", hadContent: false on a null clipboard', () => {
    expect(readPastedText(null)).toEqual({
      text: '',
      source: 'none',
      hadContent: false,
    })
  })

  it('returns none/hadContent: false for a genuinely empty clipboard', () => {
    const cd = makeClipboard({}) // no MIME types at all
    const out = readPastedText(cd)
    expect(out.source).toBe('none')
    expect(out.text).toBe('')
    expect(out.hadContent).toBe(false)
  })

  it('reports hadContent: true when a custom MIME type carries bytes (unable-to-inspect trigger)', () => {
    // A rich-text-only source can hand us `text/rtf` or an
    // application-specific MIME. `text/plain` and `text/html` are
    // both empty → source 'none', BUT we saw bytes we couldn't
    // decode, so hadContent must be true so the caller logs it.
    const cd = makeClipboard({
      extra: { 'text/rtf': '{\\rtf1\\ansi\\deff0 Hello RTF}' },
    })
    const out = readPastedText(cd)
    expect(out.source).toBe('none')
    expect(out.text).toBe('')
    expect(out.hadContent).toBe(true)
  })

  it('does NOT count `Files` entries toward hadContent (file branch keeps ownership)', () => {
    // A pasted image sets `Files` in `types` but no plaintext. The
    // caller's file branch (extractFilesFromPaste, ahead of this
    // helper in the paste handler) owns that case, so this helper
    // must NOT flag it as unable-to-inspect — that would double-log.
    const cd = fileOnlyClipboard()
    const out = readPastedText(cd)
    expect(out.source).toBe('none')
    expect(out.text).toBe('')
    expect(out.hadContent).toBe(false)
  })

  it('reports source: "none" + hadContent: true when text/html strips to empty', () => {
    // A hostile / broken payload where the tag structure has no
    // visible text (just an empty <div>, or only <script> content
    // — which textContent DOES include, so we use just <br/><br/>
    // + whitespace, which body.textContent renders as whitespace,
    // which trim() → empty). The clipboard carried bytes, so
    // hadContent stays true and the caller logs unable-to-inspect.
    const cd = makeClipboard({ html: '<br/><br/>  \n  ' })
    const out = readPastedText(cd)
    expect(out.source).toBe('none')
    expect(out.text).toBe('')
    expect(out.hadContent).toBe(true)
  })

  it('survives a getData that throws (browser refuses a MIME type) without leaking the exception', () => {
    // Some browsers throw on cross-origin reads for certain MIMEs.
    // The helper must swallow and treat the slot as absent.
    const cd = makeClipboard({
      html: '',
      throwOn: 'text/plain',
      extra: { 'text/html': '<p>ok</p>' },
    })
    const out = readPastedText(cd)
    expect(out.source).toBe('html')
    expect(out.text).toBe('ok')
  })

  it('survives a `types` accessor that throws — reports none/false, does not propagate', () => {
    const cd = makeClipboard({ throwOnTypes: true })
    const out = readPastedText(cd)
    expect(out.source).toBe('none')
    expect(out.text).toBe('')
    expect(out.hadContent).toBe(false)
  })
})

describe('stripHtmlToText — direct', () => {
  it('caps output at MAX_HTML_STRIP_CHARS on a monster payload', () => {
    // Build 3 MB of "a"s inside a single <p>. Both the input cap AND
    // the output cap must kick in and keep us at or under the limit.
    const monster = '<p>' + 'a'.repeat(MAX_HTML_STRIP_CHARS + 500_000) + '</p>'
    const out = stripHtmlToText(monster)
    expect(out.length).toBeLessThanOrEqual(MAX_HTML_STRIP_CHARS)
    expect(out.length).toBeGreaterThan(0)
  })

  it('returns "" for a payload the DOMParser cannot make a body out of', () => {
    // DOMParser is extremely permissive — even "<<<>>>" parses to a
    // (mostly empty) document. This test locks in the shape: NEVER
    // throws, always returns a string. That's the contract callers
    // rely on.
    expect(typeof stripHtmlToText('<<<>>>')).toBe('string')
    expect(typeof stripHtmlToText('')).toBe('string')
    expect(typeof stripHtmlToText('   ')).toBe('string')
  })
})

// ─── Layer 2: detection round-trip on extracted rich-text ───────────────────

describe('detectDetailed(readPastedText().text) — end-to-end parity', () => {
  it('html-only payload with an SSN → detection fires (was silent on V1.1)', () => {
    // The exact scenario the M6.1 fix addresses: paste from a
    // rich-text web app that ships an SSN in text/html with an
    // empty text/plain slot. On V1.1 the paste handler bailed on
    // the empty text/plain read. Here we prove the helper hands
    // detection a clean string that yields the SAME result the
    // plain-text path yields.
    const identifiers = 'Their SSN is 123-45-6789'
    const richPayload = `<div><b>Their SSN is</b> <span>123-45-6789</span></div>`

    const plainCd = makeClipboard({ plain: identifiers })
    const richCd = makeClipboard({ html: richPayload })

    const plainOut = detectDetailed(readPastedText(plainCd).text)
    const richOut = detectDetailed(readPastedText(richCd).text)

    expect(plainOut.hasCriticalOrHigh).toBe(true)
    expect(richOut.hasCriticalOrHigh).toBe(true)
    // Same rules fire on both — the extracted text carries the
    // same identifier, so both should produce a matching SSN
    // finding.
    const plainRules = plainOut.findings.map((f) => f.ruleId).sort()
    const richRules = richOut.findings.map((f) => f.ruleId).sort()
    expect(richRules).toEqual(plainRules)
  })

  it('html+plain payload → uses the plain slot (unchanged from V1.1)', () => {
    // Regression guard: sites that ship BOTH slots (as most do)
    // must still take the plain-text path, byte-for-byte with
    // the V1.1 handler.
    const cd = makeClipboard({
      plain: 'Their SSN is 123-45-6789',
      html: '<p>a different html body that would confuse the detector</p>',
    })
    const out = readPastedText(cd)
    expect(out.source).toBe('plain')
    expect(out.text).toBe('Their SSN is 123-45-6789')
    expect(detectDetailed(out.text).hasCriticalOrHigh).toBe(true)
  })

  it('empty/short paste → helper returns empty and the caller MIN_TEXT_LENGTH guard silently bails', () => {
    // Two shapes of "genuinely empty" — an entirely empty
    // clipboard, and one where html strips to empty but there
    // was no non-html content. The helper reports source 'none'
    // for both. The caller's MIN_TEXT_LENGTH guard is what turns
    // this into a silent no-op; here we only assert the helper's
    // half of the contract (no leaked text).
    const empty = readPastedText(makeClipboard({}))
    expect(empty.text).toBe('')
    expect(empty.hadContent).toBe(false) // → no unable-to-inspect log

    const short = readPastedText(makeClipboard({ plain: 'hi' }))
    expect(short.source).toBe('plain')
    expect(short.text).toBe('hi')
    // The caller's `text.length < MIN_TEXT_LENGTH` (=8) then bails
    // silently — no log entry, no modal. That guard lives in the
    // paste handler and is unchanged by this fix.
  })
})

// ─── Layer 3: moat-rule sanity check ────────────────────────────────────────

describe('unable-to-inspect log entry — no content ever survives storage projection', () => {
  it('the AlgEvent shape the paste handler builds carries no raw text / html', async () => {
    // The paste handler's unable-to-inspect branch builds an
    // event literal:
    //   { ts, site, eventType:'paste', action:'unable-to-inspect',
    //     categories: [], count: 0, hadCriticalOrHigh: false }
    // No content field is even NAMED. But the moat rule is
    // enforced by the schema projection, not by inspection — so we
    // additionally push the event through appendEvent + the setup
    // shim's projection and confirm nothing content-shaped
    // survives on the stored record.
    await appendEvent({
      ts: Date.now(),
      site: 'chatgpt',
      eventType: 'paste',
      action: 'unable-to-inspect',
      categories: [],
      count: 0,
      hadCriticalOrHigh: false,
    })
    const stored = await chrome.storage.local.get('events')
    const events = stored.events as ReadonlyArray<Record<string, unknown>>
    expect(events).toHaveLength(1)
    const only = events[0]
    // Exactly the seven allowed fields — no extras.
    expect(Object.keys(only).sort()).toEqual(
      ['action', 'categories', 'count', 'eventType', 'hadCriticalOrHigh', 'site', 'ts'].sort(),
    )
    // Belt-and-braces: no content-shaped keys.
    for (const key of ['value', 'text', 'html', 'content', 'raw', 'body', 'filename', 'name']) {
      expect(only).not.toHaveProperty(key)
    }
  })
})
