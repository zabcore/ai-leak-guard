// @vitest-environment jsdom
//
// A2 hardening regressions from the first CodeRabbit review of PR
// #30. Covers:
//   • decodeXmlEntities does NOT throw on an out-of-range numeric
//     entity (previously `String.fromCodePoint` would raise
//     RangeError, poisoning the whole document as parse-error).
//   • docx / pptx reject a hostile archive whose declared
//     uncompressed size exceeds the per-entry cap (ZIP-bomb defence).
//   • The pdf.js loader caches an IN-FLIGHT initialisation promise,
//     so two concurrent extractions share ONE worker instead of
//     racing to spawn (and then leak) duplicates.
//   • inspectFiles bounds concurrency to a small worker pool so a
//     50-file drop cannot hold 50 × 20 MB simultaneously.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import JSZip from 'jszip'
import { decodeXmlEntities } from '../../src/content/extraction/formats/xml-text'
import { extractText } from '../../src/content/extraction/extract'
import { MAX_UNCOMPRESSED_ENTRY_BYTES as DOCX_CAP } from '../../src/content/extraction/formats/docx'
import { MAX_UNCOMPRESSED_ENTRY_BYTES as PPTX_CAP } from '../../src/content/extraction/formats/pptx'

describe('decodeXmlEntities — hostile numeric entities', () => {
  it('accepts valid basic entities and preserves the rest of the text', () => {
    expect(decodeXmlEntities('a &amp; b &lt;x&gt; &quot;q&quot; &apos;p&apos; &#65;')).toBe(
      'a & b <x> "q" \'p\' A',
    )
  })

  it('does NOT throw on a decimal code point above 0x10FFFF (out of Unicode range)', () => {
    // `&#1114112;` == 0x110000 — one past the last valid code point.
    // Without the guard, `String.fromCodePoint` throws RangeError.
    let out = ''
    expect(() => {
      out = decodeXmlEntities('start &#1114112; end')
    }).not.toThrow()
    expect(out).toBe('start  end') // out-of-range entity dropped, surrounding text preserved
  })

  it('does NOT throw on a hex code point above 0x10FFFF', () => {
    let out = ''
    expect(() => {
      out = decodeXmlEntities('a &#x110000; b')
    }).not.toThrow()
    expect(out).toBe('a  b')
  })

  it('drops surrogate-half code points instead of producing lone surrogates', () => {
    expect(decodeXmlEntities('x &#xD800; y')).toBe('x  y')
    expect(decodeXmlEntities('x &#xDFFF; y')).toBe('x  y')
  })
})

describe('docx / pptx — ZIP-bomb defence (per-entry uncompressed cap)', () => {
  it('docx rejects an entry whose declared uncompressed size exceeds the cap', async () => {
    const zip = new JSZip()
    zip.file(
      'word/document.xml',
      '<w:document><w:body><w:p><w:r><w:t>hi</w:t></w:r></w:p></w:body></w:document>',
    )
    const buf = await zip.generateAsync({ type: 'arraybuffer' })
    // Load, mutate the entry to claim a huge uncompressed size, then
    // re-serialise via extractText path — but simpler: build a File
    // and, before extraction, tamper with the loaded zip. We can't
    // easily inject into extract.ts, so instead re-import the docx
    // extractor and pass a real (in-memory) JSZip that we've
    // tampered with. Kept minimal: verify the guard by mocking the
    // uncompressed size field on the entry BEFORE the extractor
    // decompresses.
    const file = new File([buf], 'bomb.docx', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    })
    // Monkeypatch JSZip.loadAsync so the returned zip's document.xml
    // entry claims a fake huge uncompressed size. The extractor
    // reads `_data.uncompressedSize`.
    const originalLoadAsync = JSZip.loadAsync.bind(JSZip)
    const spy = vi
      .spyOn(JSZip, 'loadAsync')
      .mockImplementation(async (arg: unknown, options?: unknown) => {
        const z = await originalLoadAsync(arg as ArrayBuffer, options as never)
        const entry = z.file('word/document.xml')!
        const rec = (entry as unknown as { _data: { uncompressedSize?: number } })._data
        rec.uncompressedSize = DOCX_CAP + 1
        return z
      })
    const result = await extractText(file)
    expect(result.status).toBe('unable_to_inspect')
    expect(result.reason).toBe('too-large')
    spy.mockRestore()
  })

  it('pptx rejects a slide whose declared uncompressed size exceeds the cap', async () => {
    const zip = new JSZip()
    zip.file(
      'ppt/slides/slide1.xml',
      '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:p><a:r><a:t>x</a:t></a:r></a:p></p:sld>',
    )
    const buf = await zip.generateAsync({ type: 'arraybuffer' })
    const file = new File([buf], 'bomb.pptx', {
      type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    })
    const originalLoadAsync = JSZip.loadAsync.bind(JSZip)
    const spy = vi
      .spyOn(JSZip, 'loadAsync')
      .mockImplementation(async (arg: unknown, options?: unknown) => {
        const z = await originalLoadAsync(arg as ArrayBuffer, options as never)
        const entry = z.file('ppt/slides/slide1.xml')!
        const rec = (entry as unknown as { _data: { uncompressedSize?: number } })._data
        rec.uncompressedSize = PPTX_CAP + 1
        return z
      })
    const result = await extractText(file)
    expect(result.status).toBe('unable_to_inspect')
    expect(result.reason).toBe('too-large')
    spy.mockRestore()
  })
})

describe('pdf.js loader — concurrent calls share one Worker (no leak)', () => {
  // The pdf.js module is mocked so we can count how many times the
  // worker constructor is invoked; without the in-flight-promise
  // cache, two concurrent PDF extractions would spawn two workers.

  let workerConstructCount = 0

  beforeEach(async () => {
    workerConstructCount = 0
    vi.doMock('pdfjs-dist', () => ({
      GlobalWorkerOptions: {},
      getDocument: () => ({
        promise: Promise.resolve({
          numPages: 1,
          getPage: async () => ({
            getTextContent: async () => ({ items: [{ str: 'stub' }] }),
            cleanup: () => {},
          }),
          destroy: async () => {},
        }),
        destroy: async () => {},
      }),
    }))
    vi.doMock('pdfjs-dist/build/pdf.worker.mjs?worker', () => ({
      default: class FakeWorker {
        constructor() {
          workerConstructCount += 1
        }
      },
    }))
    const { __resetPdfjsForTesting } = await import('../../src/content/extraction/formats/pdf')
    __resetPdfjsForTesting()
  })

  afterEach(() => {
    vi.doUnmock('pdfjs-dist')
    vi.doUnmock('pdfjs-dist/build/pdf.worker.mjs?worker')
    vi.resetModules()
  })

  it('two concurrent extractPdf calls construct only ONE Worker', async () => {
    const { extractPdf } = await import('../../src/content/extraction/formats/pdf')
    const pdfHeader = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34])
    const a = new File([pdfHeader], 'a.pdf', { type: 'application/pdf' })
    const b = new File([pdfHeader], 'b.pdf', { type: 'application/pdf' })
    const [ra, rb] = await Promise.all([extractPdf(a), extractPdf(b)])
    expect(ra.kind).toBe('text')
    expect(rb.kind).toBe('text')
    expect(workerConstructCount).toBe(1)
  })
})

describe('zip-read — streaming cap enforcement (second-round CR)', () => {
  // The declared-size PRE-check catches an honest archive that
  // openly says "I inflate to 500 MB". The STREAMING check catches
  // the harder case: an archive whose header lies (declared: 100 B,
  // actual: MBs). readEntryBoundedText hooks the jszip stream and
  // rejects the moment a chunk pushes the running total past the
  // cap, so memory stays bounded regardless of what the header
  // claims.

  it('rejects an entry whose real decompressed size exceeds the cap even with a lying header', async () => {
    const { readEntryBoundedText } = await import('../../src/content/extraction/formats/zip-read')
    const zip = new JSZip()
    // A ~2 KB payload — bigger than the tiny cap we'll set.
    zip.file('a.txt', 'x'.repeat(2048))
    const buf = await zip.generateAsync({ type: 'arraybuffer' })
    const loaded = await JSZip.loadAsync(buf)
    const entry = loaded.file('a.txt')!
    // Lie about the size: claim 4 bytes so the pre-check passes.
    const rec = (entry as unknown as { _data: { uncompressedSize?: number } })._data
    rec.uncompressedSize = 4
    const result = await readEntryBoundedText(entry, { cap: 256 })
    expect(result.kind).toBe('over-cap')
    if (result.kind === 'over-cap') {
      expect(result.bytesRead).toBeGreaterThan(256)
    }
  })

  it('fails closed when the declared uncompressed size is missing', async () => {
    const { readEntryBoundedText } = await import('../../src/content/extraction/formats/zip-read')
    const zip = new JSZip()
    zip.file('a.txt', 'hello')
    const buf = await zip.generateAsync({ type: 'arraybuffer' })
    const loaded = await JSZip.loadAsync(buf)
    const entry = loaded.file('a.txt')!
    const rec = (entry as unknown as { _data: { uncompressedSize?: number } })._data
    // Remove the declared size — a header that lies by omission.
    delete rec.uncompressedSize
    const result = await readEntryBoundedText(entry, { cap: 1024 })
    expect(result.kind).toBe('over-cap')
  })

  it('returns text for a well-formed entry within the cap', async () => {
    const { readEntryBoundedText } = await import('../../src/content/extraction/formats/zip-read')
    const zip = new JSZip()
    zip.file('a.txt', 'hello world')
    const buf = await zip.generateAsync({ type: 'arraybuffer' })
    const loaded = await JSZip.loadAsync(buf)
    const entry = loaded.file('a.txt')!
    const result = await readEntryBoundedText(entry, { cap: 1024 })
    expect(result.kind).toBe('text')
    if (result.kind === 'text') {
      expect(result.text).toBe('hello world')
      expect(result.bytesRead).toBe('hello world'.length)
    }
  })
})

describe('zip-read — OPC-mandated encodings (UTF-8 + UTF-16)', () => {
  // ECMA-376 Part 2 (OPC) mandates that XML parts inside an OOXML
  // package are encoded as UTF-8 or UTF-16. `decodeXmlBytes` sniffs
  // the BOM and dispatches to the right TextDecoder. Missing this in
  // the earlier commit meant a UTF-16 docx/pptx would come out as
  // NULs + replacement chars, and the `<w:t>` / `<a:t>` regex would
  // find nothing.

  it('decodeXmlBytes handles UTF-8 without a BOM (the common case)', async () => {
    const { decodeXmlBytes } = await import('../../src/content/extraction/formats/zip-read')
    const bytes = new TextEncoder().encode('<w:t>hello</w:t>')
    expect(decodeXmlBytes(bytes)).toBe('<w:t>hello</w:t>')
  })

  it('decodeXmlBytes strips the UTF-8 BOM', async () => {
    const { decodeXmlBytes } = await import('../../src/content/extraction/formats/zip-read')
    const bom = new Uint8Array([0xef, 0xbb, 0xbf])
    const body = new TextEncoder().encode('<w:t>x</w:t>')
    const combined = new Uint8Array(bom.length + body.length)
    combined.set(bom, 0)
    combined.set(body, bom.length)
    const out = decodeXmlBytes(combined)
    // No leading U+FEFF.
    expect(out.charCodeAt(0)).toBe('<'.charCodeAt(0))
    expect(out).toBe('<w:t>x</w:t>')
  })

  it('decodeXmlBytes decodes UTF-16 LE (BOM: FF FE)', async () => {
    const { decodeXmlBytes } = await import('../../src/content/extraction/formats/zip-read')
    const src = '<w:t>UTF16LE_SENTINEL</w:t>'
    // Encode as UTF-16LE with BOM.
    const buf = new Uint8Array(2 + src.length * 2)
    buf[0] = 0xff
    buf[1] = 0xfe
    for (let i = 0; i < src.length; i++) {
      const cp = src.charCodeAt(i)
      buf[2 + i * 2] = cp & 0xff
      buf[2 + i * 2 + 1] = (cp >> 8) & 0xff
    }
    expect(decodeXmlBytes(buf)).toBe(src)
  })

  it('decodeXmlBytes decodes UTF-16 BE (BOM: FE FF)', async () => {
    const { decodeXmlBytes } = await import('../../src/content/extraction/formats/zip-read')
    const src = '<a:t>UTF16BE_SENTINEL</a:t>'
    const buf = new Uint8Array(2 + src.length * 2)
    buf[0] = 0xfe
    buf[1] = 0xff
    for (let i = 0; i < src.length; i++) {
      const cp = src.charCodeAt(i)
      buf[2 + i * 2] = (cp >> 8) & 0xff
      buf[2 + i * 2 + 1] = cp & 0xff
    }
    expect(decodeXmlBytes(buf)).toBe(src)
  })

  it('docx extractor pulls text from a UTF-16 LE document.xml', async () => {
    const src = `<?xml version="1.0" encoding="UTF-16"?><w:document><w:body><w:p><w:r><w:t>UTF16LE_DOCX_SENTINEL</w:t></w:r></w:p></w:body></w:document>`
    const buf = new Uint8Array(2 + src.length * 2)
    buf[0] = 0xff
    buf[1] = 0xfe
    for (let i = 0; i < src.length; i++) {
      const cp = src.charCodeAt(i)
      buf[2 + i * 2] = cp & 0xff
      buf[2 + i * 2 + 1] = (cp >> 8) & 0xff
    }
    const zip = new JSZip()
    zip.file('word/document.xml', buf, { binary: true })
    const bytes = await zip.generateAsync({ type: 'arraybuffer' })
    const file = new File([bytes], 'utf16.docx', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    })
    const result = await extractText(file)
    expect(result.status).toBe('extracted')
    expect(result.text).toContain('UTF16LE_DOCX_SENTINEL')
  })

  it('pptx extractor pulls text from a UTF-16 BE slide.xml', async () => {
    const src = `<?xml version="1.0" encoding="UTF-16"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:p><a:r><a:t>UTF16BE_PPTX_SENTINEL</a:t></a:r></a:p></p:sld>`
    const buf = new Uint8Array(2 + src.length * 2)
    buf[0] = 0xfe
    buf[1] = 0xff
    for (let i = 0; i < src.length; i++) {
      const cp = src.charCodeAt(i)
      buf[2 + i * 2] = (cp >> 8) & 0xff
      buf[2 + i * 2 + 1] = cp & 0xff
    }
    const zip = new JSZip()
    zip.file('ppt/slides/slide1.xml', buf, { binary: true })
    const bytes = await zip.generateAsync({ type: 'arraybuffer' })
    const file = new File([bytes], 'utf16.pptx', {
      type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    })
    const result = await extractText(file)
    expect(result.status).toBe('extracted')
    expect(result.text).toContain('UTF16BE_PPTX_SENTINEL')
  })
})

describe('zip-read — AbortSignal propagation (fourth-round CR)', () => {
  // Without signal wiring, docx/pptx extraction would keep JSZip
  // decompressing after `extract.ts`'s 10 s timeout fires. The
  // caller returns the timeout result to its caller but JSZip
  // continues appending chunks in the background — CPU / memory
  // don't get released until the entry either completes or crosses
  // the cap. Passing the signal through lets us pause the stream
  // and settle immediately when the deadline hits.

  it('readEntryBoundedText settles as aborted when signal fires mid-stream', async () => {
    const { readEntryBoundedText } = await import('../../src/content/extraction/formats/zip-read')
    const zip = new JSZip()
    zip.file('a.txt', 'x'.repeat(4096))
    const buf = await zip.generateAsync({ type: 'arraybuffer' })
    const loaded = await JSZip.loadAsync(buf)
    const entry = loaded.file('a.txt')!
    const ac = new AbortController()
    // Fire the abort on the next microtask so at least one data
    // chunk has a chance to arrive first.
    void Promise.resolve().then(() => ac.abort())
    const result = await readEntryBoundedText(entry, { cap: 1024 * 1024, signal: ac.signal })
    expect(result.kind).toBe('aborted')
  })

  it('returns aborted immediately when the signal is already aborted', async () => {
    const { readEntryBoundedText } = await import('../../src/content/extraction/formats/zip-read')
    const zip = new JSZip()
    zip.file('a.txt', 'hi')
    const buf = await zip.generateAsync({ type: 'arraybuffer' })
    const loaded = await JSZip.loadAsync(buf)
    const entry = loaded.file('a.txt')!
    const ac = new AbortController()
    ac.abort()
    const result = await readEntryBoundedText(entry, { cap: 1024, signal: ac.signal })
    expect(result.kind).toBe('aborted')
    if (result.kind === 'aborted') expect(result.bytesRead).toBe(0)
  })
})

describe('pdf extractor — cleanup on load failure (second-round CR)', () => {
  // Previous split-try structure skipped safeDestroy(loadingTask)
  // when the initial loadingTask.promise rejected with anything
  // other than PasswordException, leaking the worker's slot. The
  // single outer try/finally must destroy on every path.

  it('calls loadingTask.destroy() when the initial load rejects with a non-password error', async () => {
    let destroyCalls = 0
    vi.doMock('pdfjs-dist', () => ({
      GlobalWorkerOptions: { workerPort: {} },
      getDocument: () => ({
        promise: Promise.reject(new Error('bad pdf')),
        destroy: async () => {
          destroyCalls += 1
        },
      }),
    }))
    const { extractPdf, __resetPdfjsForTesting } =
      await import('../../src/content/extraction/formats/pdf')
    __resetPdfjsForTesting()
    const pdfHeader = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34])
    const file = new File([pdfHeader], 'a.pdf', { type: 'application/pdf' })
    // extractPdf throws internally; extract.ts catches. We call it
    // directly to isolate the cleanup guarantee.
    await expect(extractPdf(file)).rejects.toThrow('bad pdf')
    expect(destroyCalls).toBe(1)
    vi.doUnmock('pdfjs-dist')
  })
})

describe('inspectFiles — bounded concurrency', () => {
  // Verify that a large drop does not run every extraction
  // simultaneously. We do this by counting in-flight extractText
  // calls (via a text-format mock that resolves after a scheduled
  // microtask hop).

  it('caps parallel extractions to the small worker-pool limit', async () => {
    let inFlight = 0
    let observedMax = 0
    vi.doMock('../../src/content/extraction/formats/text', () => ({
      extractPlainText: async (): Promise<{ kind: string; text?: string }> => {
        inFlight += 1
        observedMax = Math.max(observedMax, inFlight)
        // Yield twice so multiple pool workers get a chance to
        // start before any completes.
        await Promise.resolve()
        await Promise.resolve()
        inFlight -= 1
        return { kind: 'text', text: 'x' }
      },
    }))
    const { inspectFiles, MAX_CONCURRENT_EXTRACTIONS } =
      await import('../../src/content/file-inspector')
    const files: File[] = []
    for (let i = 0; i < 20; i++) {
      files.push(new File([`content-${i}`], `n${i}.txt`, { type: 'text/plain' }))
    }
    const out = await inspectFiles(files)
    expect(out.perFile).toHaveLength(20)
    expect(observedMax).toBeGreaterThan(0)
    expect(observedMax).toBeLessThanOrEqual(MAX_CONCURRENT_EXTRACTIONS)
    vi.doUnmock('../../src/content/extraction/formats/text')
  })
})
