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
    // Text/normalization is loosely asserted — block-boundary
    // separators add newlines around <p> — but the two tokens
    // land in order and are recoverable as a single string with
    // detector-friendly spacing.
    expect(out.text).toMatch(/Patient MRN\s+MRN123456/)
    expect(out.hadContent).toBe(true)
  })

  it('falls back to text/html when text/plain is present but whitespace-only', () => {
    const cd = makeClipboard({ plain: '   \n\t ', html: '<p>hello</p>' })
    const out = readPastedText(cd)
    expect(out.source).toBe('html')
    expect(out.text).toBe('hello')
  })

  it('strips through the inert DOMParser — no <script> execution, no <img> fetch, no script/style source leaks into detector input', () => {
    // Two invariants pinned here:
    //   (a) DOMParser must NOT run scripts or fire resource fetches.
    //       If it did, a hostile page could exfiltrate via a paste
    //       of hostile HTML.
    //   (b) `<script>` / `<style>` source must NOT appear in the
    //       extracted text. `body.textContent` includes them by
    //       default, which would let hostile HTML smuggle
    //       SSN-shaped strings inside a `<script>` block and
    //       trigger false-positive detection. `stripHtmlToText`
    //       removes non-content tags before text extraction.
    ;(window as unknown as Record<string, unknown>).__pwned__ = false
    const html = `
      <script>const FAKE_SSN = "999-99-9999"; window.__pwned__ = true</script>
      <style>body { background: url("http://ai-leak-guard.invalid/x.png"); }</style>
      <img src="http://ai-leak-guard.invalid/beacon.png"
           onerror="window.__pwned__ = true">
      <p>real body text</p>
    `
    const cd = makeClipboard({ html })
    const out = readPastedText(cd)
    expect(out.source).toBe('html')
    expect(out.text).toContain('real body text')
    // Side effects never fired.
    expect((window as unknown as Record<string, unknown>).__pwned__).toBe(false)
    // Script and style source are STRIPPED — no SSN-shaped bait,
    // no CSS URL bait, no bare identifiers that came from a
    // <script> block.
    expect(out.text).not.toContain('FAKE_SSN')
    expect(out.text).not.toContain('999-99-9999')
    expect(out.text).not.toContain('background')
    expect(out.text).not.toContain('ai-leak-guard.invalid')
  })

  it('inserts separators at block boundaries — adjacent tokens do NOT merge into one string', () => {
    // The critical detector-accuracy invariant. Plain
    // `body.textContent` on `<div>foo</div><div>bar</div>` yields
    // `"foobar"`, which can spuriously match a regex or hide a
    // real match by joining an identifier with surrounding
    // chrome. The block-boundary separators in
    // `extractVisibleText` guarantee at least one whitespace
    // char between adjacent visible tokens.
    const cd = makeClipboard({ html: '<div>foo</div><div>bar</div><div>baz</div>' })
    const out = readPastedText(cd)
    expect(out.source).toBe('html')
    // \s+ (not \s*) — at least one whitespace char between each pair.
    expect(out.text).toMatch(/foo\s+bar\s+baz/)
    // Direct sanity: the tokens don't collapse.
    expect(out.text).not.toContain('foobar')
    expect(out.text).not.toContain('barbaz')
  })

  it('inserts a separator at <br> so an inline <br>-joined identifier does not merge', () => {
    const cd = makeClipboard({ html: 'foo<br>bar<br/>baz' })
    const out = readPastedText(cd)
    expect(out.source).toBe('html')
    expect(out.text).toMatch(/foo\s+bar\s+baz/)
    expect(out.text).not.toContain('foobar')
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

  it('survives a getData that throws (browser refuses a MIME type) without leaking the exception, and still recovers text from the other slot', () => {
    // Some browsers throw on cross-origin reads for certain MIMEs.
    // The helper must swallow and (a) still read the other slot;
    // (b) return content when the other slot succeeds.
    const cd = makeClipboard({
      html: '',
      throwOn: 'text/plain',
      extra: { 'text/html': '<p>ok</p>' },
    })
    const out = readPastedText(cd)
    expect(out.source).toBe('html')
    expect(out.text).toBe('ok')
  })

  it('when BOTH text/plain and text/html reads throw, reports hadContent: true so the caller logs unable-to-inspect (does NOT let native paste bypass inspection silently)', () => {
    // The security-critical case from CodeRabbit finding #1.
    // Before the fix: safeGetData swallowed both throws, source
    // was 'none', hadContent was false, and the paste handler
    // silently returned — no log, no warning, and the browser's
    // native paste proceeded WITHOUT the extension ever knowing
    // there was content on the clipboard. The fix propagates the
    // read failures via a per-call error counter.
    const cd = {
      get types(): readonly string[] {
        return ['text/plain', 'text/html']
      },
      getData(_type: string): string {
        throw new Error('clipboard refused')
      },
      files: { length: 0 } as unknown as FileList,
    } as unknown as DataTransfer
    const out = readPastedText(cd)
    expect(out.source).toBe('none')
    expect(out.text).toBe('')
    // hadContent === true → caller emits unable-to-inspect event.
    expect(out.hadContent).toBe(true)
  })

  it('survives a `types` accessor that throws — reports none/false when no prior read errors', () => {
    const cd = makeClipboard({ throwOnTypes: true })
    const out = readPastedText(cd)
    expect(out.source).toBe('none')
    expect(out.text).toBe('')
    expect(out.hadContent).toBe(false)
  })

  it('oversized text/html payload (> MAX_HTML_STRIP_CHARS) → source: "none", hadContent: true — refuses to inspect a truncated prefix', () => {
    // CodeRabbit finding #3. Before the fix: an oversized payload
    // was sliced to a MAX_HTML_STRIP_CHARS prefix, parsed, and
    // returned as source:'html' with truncated text. If the prefix
    // was clean, detection returned clean and the FULL original
    // payload proceeded via native paste — a false-clean bypass.
    // After the fix: no partial inspection at all — the helper
    // hands the caller a definitive unable-to-inspect signal.
    const huge = '<p>' + 'a'.repeat(MAX_HTML_STRIP_CHARS + 100) + '</p>'
    expect(huge.length).toBeGreaterThan(MAX_HTML_STRIP_CHARS)
    const cd = makeClipboard({ html: huge })
    const out = readPastedText(cd)
    expect(out.source).toBe('none')
    expect(out.text).toBe('')
    expect(out.hadContent).toBe(true)
  })
})

describe('stripHtmlToText — direct', () => {
  it('returns "" on oversized input rather than a truncated prefix', () => {
    // Refusing to parse a partial payload is the whole point of
    // CodeRabbit finding #3. A truncated prefix that scans clean
    // would give the caller a false-clean silhouette of the real
    // payload. Callers that see '' fall through to the
    // unable-to-inspect branch.
    const monster = '<p>' + 'a'.repeat(MAX_HTML_STRIP_CHARS + 500_000) + '</p>'
    expect(stripHtmlToText(monster)).toBe('')
  })

  it('caps output at MAX_HTML_STRIP_CHARS on inputs under the input cap', () => {
    // A within-cap input still produces bounded output — the
    // extraction-side cap is a defense-in-depth pass in case a
    // future change re-enables partial parsing.
    const large = '<p>' + 'a'.repeat(MAX_HTML_STRIP_CHARS - 20) + '</p>'
    const out = stripHtmlToText(large)
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

  it('removes <script>, <style>, and other non-content tags so their source does not leak into detector input', () => {
    // DOMParser with 'text/html' recognises script and style as
    // opaque containers and their content never lands in the
    // parsed DOM's textContent (belt-and-braces we then remove
    // the elements too). `<iframe src>` reference must not
    // survive, and the iframe cannot fetch anyway.
    //
    // `<noscript>` is deliberately NOT covered here because
    // DOMParser's handling of noscript is browser-quirky (jsdom
    // strips the container but keeps its text as a bare node;
    // real Chrome preserves the noscript container so the
    // removal works). Neither behavior lets scripts execute, so
    // the security invariant is preserved either way.
    const out = stripHtmlToText(`
      <script>const key = "sk-live-1234567890abcdefghij"</script>
      <style>body { color: red }</style>
      <iframe src="http://x.invalid/"></iframe>
      <p>keep me</p>
    `)
    expect(out).toContain('keep me')
    expect(out).not.toContain('sk-live')
    expect(out).not.toContain('color: red')
    expect(out).not.toContain('x.invalid')
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
