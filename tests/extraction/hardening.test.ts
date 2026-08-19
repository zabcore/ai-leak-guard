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
