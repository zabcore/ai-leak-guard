// @vitest-environment jsdom
//
// The extraction layer promises **zero network**: no parser may
// fetch fonts, workers, dictionaries, or anything else at runtime.
// This test stubs `fetch` and `XMLHttpRequest.prototype.open`, runs
// extractText across every supported format, and asserts neither
// was ever touched.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import JSZip from 'jszip'
import * as XLSX from 'xlsx'
import { extractText } from '../../src/content/extraction/extract'

// pdf.js needs a Worker in jsdom (which has none); we mock it here
// so the no-network run for a PDF exercises the extractor's
// pass-through-to-pdfjs logic without spawning a real worker or
// touching a real font store.
vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerPort: {} },
  getDocument: () => ({
    promise: Promise.resolve({
      numPages: 1,
      getPage: async () => ({
        getTextContent: async () => ({ items: [{ str: 'SENTINEL_PDF_NONET' }] }),
        cleanup: () => {},
      }),
      destroy: async () => {},
    }),
  }),
}))

let fetchCalls: unknown[][] = []
let xhrOpenCalls: unknown[][] = []
let origFetch: typeof globalThis.fetch | undefined
let origXhrOpen: XMLHttpRequest['open']

beforeEach(() => {
  fetchCalls = []
  xhrOpenCalls = []
  origFetch = globalThis.fetch
  // A hard stub — throws on any invocation so a parser that tries
  // to fetch will crash and its failure will surface as
  // parse-error, keeping this test from silently missing a leak.
  globalThis.fetch = ((...args: unknown[]) => {
    fetchCalls.push(args)
    throw new Error('network access blocked by no-network test')
  }) as unknown as typeof globalThis.fetch
  origXhrOpen = XMLHttpRequest.prototype.open
  XMLHttpRequest.prototype.open = function (...args: unknown[]) {
    xhrOpenCalls.push(args)
    throw new Error('XHR blocked by no-network test')
  } as unknown as XMLHttpRequest['open']
})

afterEach(() => {
  if (origFetch !== undefined) globalThis.fetch = origFetch
  XMLHttpRequest.prototype.open = origXhrOpen
  vi.restoreAllMocks()
})

async function docxFile(): Promise<File> {
  const zip = new JSZip()
  zip.file(
    'word/document.xml',
    '<w:document><w:body><w:p><w:r><w:t>x</w:t></w:r></w:p></w:body></w:document>',
  )
  const bytes = await zip.generateAsync({ type: 'arraybuffer' })
  return new File([bytes], 'a.docx', {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  })
}

async function pptxFile(): Promise<File> {
  const zip = new JSZip()
  zip.file(
    'ppt/slides/slide1.xml',
    '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:p><a:r><a:t>y</a:t></a:r></a:p></p:sld>',
  )
  const bytes = await zip.generateAsync({ type: 'arraybuffer' })
  return new File([bytes], 'a.pptx', {
    type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  })
}

function xlsxFile(): File {
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['x']]), 'S')
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
  return new File([new Uint8Array(buf)], 'a.xlsx', {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
}

function txtFile(): File {
  return new File(['hi'], 'a.txt', { type: 'text/plain' })
}

function pdfFile(): File {
  const header = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34])
  return new File([header], 'a.pdf', { type: 'application/pdf' })
}

describe('extraction — zero network', () => {
  it('text extractor never calls fetch or XHR', async () => {
    const r = await extractText(txtFile())
    expect(r.status).toBe('extracted')
    expect(fetchCalls).toHaveLength(0)
    expect(xhrOpenCalls).toHaveLength(0)
  })

  it('docx extractor never calls fetch or XHR', async () => {
    const r = await extractText(await docxFile())
    expect(r.status).toBe('extracted')
    expect(fetchCalls).toHaveLength(0)
    expect(xhrOpenCalls).toHaveLength(0)
  })

  it('pptx extractor never calls fetch or XHR', async () => {
    const r = await extractText(await pptxFile())
    expect(r.status).toBe('extracted')
    expect(fetchCalls).toHaveLength(0)
    expect(xhrOpenCalls).toHaveLength(0)
  })

  it('xlsx extractor never calls fetch or XHR', async () => {
    const r = await extractText(xlsxFile())
    expect(r.status).toBe('extracted')
    expect(fetchCalls).toHaveLength(0)
    expect(xhrOpenCalls).toHaveLength(0)
  })

  it('pdf extractor never calls fetch or XHR (via the mocked pdfjs surface)', async () => {
    const r = await extractText(pdfFile())
    expect(r.status).toBe('extracted')
    expect(fetchCalls).toHaveLength(0)
    expect(xhrOpenCalls).toHaveLength(0)
  })
})
