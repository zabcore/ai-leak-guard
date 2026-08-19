// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  extractText,
  sniffFormat,
  EXTRACTION_TIMEOUT_MS,
  type ExtractionResult,
} from '../../src/content/extraction/extract'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.resetModules()
})

function fileFromBytes(name: string, type: string, bytes: number[] | Uint8Array): File {
  // Copy into a fresh ArrayBuffer so the resulting Uint8Array is
  // typed as `Uint8Array<ArrayBuffer>` (BlobPart-compatible under
  // TS 5.7+), not `Uint8Array<ArrayBufferLike>`.
  const src = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  const buf = new ArrayBuffer(src.byteLength)
  new Uint8Array(buf).set(src)
  return new File([buf], name, { type })
}

describe('sniffFormat', () => {
  it('sniffs PDF from %PDF- magic bytes regardless of MIME/extension', async () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34])
    // Intentionally wrong extension + MIME — magic wins.
    const file = fileFromBytes('mystery.bin', 'application/octet-stream', bytes)
    expect(await sniffFormat(file)).toBe('pdf')
  })

  it('sniffs ZIP-family formats via extension when magic is PK\\x03\\x04', async () => {
    const zipMagic = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0])
    expect(await sniffFormat(fileFromBytes('x.docx', 'application/octet-stream', zipMagic))).toBe(
      'docx',
    )
    expect(await sniffFormat(fileFromBytes('x.xlsx', '', zipMagic))).toBe('xlsx')
    expect(await sniffFormat(fileFromBytes('x.pptx', '', zipMagic))).toBe('pptx')
    // Unknown ZIP → unknown.
    expect(await sniffFormat(fileFromBytes('x.zip', '', zipMagic))).toBe('unknown')
  })

  it('sniffs text/csv/md by extension when no binary magic matches', async () => {
    const txt = new Uint8Array([0x68, 0x69])
    expect(await sniffFormat(fileFromBytes('a.txt', '', txt))).toBe('text')
    expect(await sniffFormat(fileFromBytes('a.md', '', txt))).toBe('text')
    expect(await sniffFormat(fileFromBytes('a.csv', '', txt))).toBe('csv')
    // Also honours MIME when extension is missing.
    expect(await sniffFormat(fileFromBytes('noext', 'text/plain', txt))).toBe('text')
    expect(await sniffFormat(fileFromBytes('noext', 'text/csv', txt))).toBe('csv')
  })

  it('does NOT trust extension over magic — image-renamed-as-pdf is unknown, not pdf', async () => {
    // JPEG magic: FF D8 FF
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0])
    expect(await sniffFormat(fileFromBytes('scan.pdf', 'application/pdf', jpeg))).toBe('unknown')
  })

  it('returns unknown for tiny / empty files with no recognisable header', async () => {
    expect(await sniffFormat(fileFromBytes('a', '', new Uint8Array()))).toBe('unknown')
  })
})

describe('extractText — guards', () => {
  it('short-circuits to too-large WITHOUT loading a parser module', async () => {
    // Fabricate a File whose reported size is over the cap; use a
    // 1-byte slice to keep the test cheap — the guard reads only
    // `file.size`, not the actual bytes.
    //
    // Belt-and-suspenders: mock the PDF format module and assert the
    // spy never fires. If some future refactor accidentally moved
    // the size check below the dispatch, this test would flag it.
    const pdfSpy = vi.fn()
    vi.doMock('../../src/content/extraction/formats/pdf', () => ({
      extractPdf: pdfSpy,
    }))
    const { extractText: freshExtract, MAX_EXTRACTION_BYTES: BYTES } =
      await import('../../src/content/extraction/extract')
    const big = new File(['x'], 'big.pdf', { type: 'application/pdf' })
    Object.defineProperty(big, 'size', { value: BYTES + 1 })
    const result = await freshExtract(big)
    expect(result.status).toBe('unable_to_inspect')
    expect(result.reason).toBe('too-large')
    // detectedFormat is left at 'unknown' because we skipped the sniff.
    expect(result.meta.detectedFormat).toBe('unknown')
    expect(pdfSpy).not.toHaveBeenCalled()
    vi.doUnmock('../../src/content/extraction/formats/pdf')
  })

  it('reports unsupported-type for unknown-format files', async () => {
    const file = new File([new Uint8Array([0x00, 0x01, 0x02, 0x03])], 'x.bin', {
      type: 'application/octet-stream',
    })
    const result = await extractText(file)
    expect(result.status).toBe('unable_to_inspect')
    expect(result.reason).toBe('unsupported-type')
    expect(result.meta.detectedFormat).toBe('unknown')
  })

  it('resolves to timeout when extraction exceeds EXTRACTION_TIMEOUT_MS', async () => {
    // Stub the text formatter to hang forever, then confirm the
    // timeout sentinel fires. We use fake timers WITH the async
    // advance helper so microtasks between the setTimeout firing
    // and Promise.race settling are flushed.
    vi.doMock('../../src/content/extraction/formats/text', () => ({
      extractPlainText: () => new Promise(() => {}), // never resolves
    }))
    const { extractText: freshExtract } = await import('../../src/content/extraction/extract')
    vi.useFakeTimers()
    const file = new File(['hi'], 'a.txt', { type: 'text/plain' })
    const pending = freshExtract(file)
    // Give the sniffer / dynamic import time to reach the
    // Promise.race — one microtask flush suffices for the sniff
    // path.
    await vi.advanceTimersByTimeAsync(EXTRACTION_TIMEOUT_MS + 1)
    const result = await pending
    expect(result.status).toBe('unable_to_inspect')
    expect(result.reason).toBe('timeout')
    vi.doUnmock('../../src/content/extraction/formats/text')
  }, 15_000)

  it('reports parse-error when an extractor throws an unclassified error', async () => {
    vi.doMock('../../src/content/extraction/formats/text', () => ({
      extractPlainText: () => Promise.reject(new Error('boom')),
    }))
    const { extractText: freshExtract } = await import('../../src/content/extraction/extract')
    const file = new File(['hi'], 'a.txt', { type: 'text/plain' })
    const result = await freshExtract(file)
    expect(result.status).toBe('unable_to_inspect')
    expect(result.reason).toBe('parse-error')
    vi.doUnmock('../../src/content/extraction/formats/text')
  })

  it('extractText NEVER throws — even on a totally malformed input', async () => {
    // A weird prototype-poisoning-ish input. We construct a File
    // normally but stub `.arrayBuffer()` to throw synchronously.
    const file = new File(['hi'], 'a.txt', { type: 'text/plain' })
    Object.defineProperty(file, 'text', {
      value: () => Promise.reject(new Error('io failure')),
    })
    Object.defineProperty(file, 'arrayBuffer', {
      value: () => {
        throw new Error('bytes gone')
      },
    })
    let result: ExtractionResult
    let threw: unknown = null
    try {
      result = await extractText(file)
    } catch (e) {
      threw = e
      throw e
    }
    expect(threw).toBeNull()
    // File slice.arrayBuffer for sniff also throws → sniffer catches
    // and returns 'unknown', so we get unsupported-type.
    expect(result!.status).toBe('unable_to_inspect')
  })
})

describe('extractText — dispatch', () => {
  it('routes text files through the text extractor and returns extracted', async () => {
    const sentinel = 'SENTINEL_TEXT_FIXTURE_2026'
    const file = new File([sentinel], 'note.txt', { type: 'text/plain' })
    const result = await extractText(file)
    expect(result.status).toBe('extracted')
    expect(result.text).toContain(sentinel)
    expect(result.meta.detectedFormat).toBe('text')
  })

  it('reports empty for a cleanly-parsed but blank file', async () => {
    const file = new File(['   \n  \t '], 'blank.txt', { type: 'text/plain' })
    const result = await extractText(file)
    expect(result.status).toBe('empty')
    expect(result.text).toBe('')
    expect(result.reason).toBe('empty')
  })

  it('passes CSV files through the plain-text path (rows preserved verbatim)', async () => {
    const csv = 'name,dob\nJane Doe,1980-01-02\n'
    const file = new File([csv], 'data.csv', { type: 'text/csv' })
    const result = await extractText(file)
    expect(result.status).toBe('extracted')
    expect(result.text).toContain('Jane Doe')
    expect(result.meta.detectedFormat).toBe('csv')
  })
})
