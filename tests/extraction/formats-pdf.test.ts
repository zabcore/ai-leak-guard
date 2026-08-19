// @vitest-environment jsdom
//
// PDF extractor tests. We CANNOT run real pdf.js in jsdom — it
// wants a Web Worker and jsdom has no Worker implementation — so we
// mock `pdfjs-dist` and `pdfjs-dist/build/pdf.worker.mjs?worker`
// with a fake that exercises the extractor's contract:
//   • options passed to `getDocument` include the security posture
//     the extractor promises (isEvalSupported:false, disableFontFace,
//     useSystemFonts:false, disableAutoFetch, disableStream).
//   • text is joined across pages with `\n`.
//   • PasswordException → EXTRACTOR_ERROR_ENCRYPTED → `encrypted`.
//   • whitespace-only text layer → EXTRACTOR_ERROR_NO_TEXT_LAYER →
//     `no-text-layer`.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface CapturedGetDocumentOpts {
  readonly [k: string]: unknown
}

let capturedOpts: CapturedGetDocumentOpts | null = null

type FakePdfPage = {
  getTextContent(): Promise<{ items: readonly { str: string }[] }>
  cleanup?: () => void
}
type FakePdfDoc = {
  numPages: number
  getPage(n: number): Promise<FakePdfPage>
  destroy(): Promise<void>
}
type FakePdfPlan = {
  loadReject?: unknown
  pages?: readonly string[][]
}

let plan: FakePdfPlan = {}

vi.mock('pdfjs-dist', () => {
  return {
    // Pre-populate workerPort so `ensureWorkerConfigured` short-
    // circuits and never reaches the `?worker` import (jsdom cannot
    // resolve Vite's `?worker` query in a plain vitest run).
    GlobalWorkerOptions: { workerPort: {} },
    getDocument: (opts: CapturedGetDocumentOpts) => {
      capturedOpts = opts
      return {
        promise: (async () => {
          if (plan.loadReject) throw plan.loadReject
          const pages = plan.pages ?? []
          const doc: FakePdfDoc = {
            numPages: pages.length,
            getPage: async (n) => ({
              getTextContent: async () => ({
                items: (pages[n - 1] ?? []).map((str) => ({ str })),
              }),
              cleanup: () => {},
            }),
            destroy: async () => {},
          }
          return doc
        })(),
      }
    },
  }
})

// A minimal 8-byte %PDF- header so the sniffer routes to the pdf
// extractor. The bytes after don't matter — pdf.js is mocked.
const PDF_HEADER = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34])

function pdfFile(): File {
  return new File([PDF_HEADER], 'sample.pdf', { type: 'application/pdf' })
}

beforeEach(() => {
  capturedOpts = null
  plan = {}
})

afterEach(() => {
  vi.resetModules()
})

async function callExtract() {
  const { extractText } = await import('../../src/content/extraction/extract')
  return extractText(pdfFile())
}

describe('pdf extractor — happy path', () => {
  it('joins page text with newlines and reports extracted', async () => {
    plan = { pages: [['SENTINEL_PDF', 'line1'], ['page2 text']] }
    const result = await callExtract()
    expect(result.status).toBe('extracted')
    expect(result.text).toContain('SENTINEL_PDF')
    expect(result.text).toContain('page2 text')
    expect(result.text).toContain('\n')
    expect(result.meta.detectedFormat).toBe('pdf')
  })

  it('passes security-posture options to pdf.js getDocument', async () => {
    plan = { pages: [['x']] }
    await callExtract()
    expect(capturedOpts).not.toBeNull()
    expect(capturedOpts!.isEvalSupported).toBe(false)
    expect(capturedOpts!.disableFontFace).toBe(true)
    expect(capturedOpts!.useSystemFonts).toBe(false)
    expect(capturedOpts!.disableAutoFetch).toBe(true)
    expect(capturedOpts!.disableStream).toBe(true)
  })
})

describe('pdf extractor — unable_to_inspect classifications', () => {
  it('reports encrypted when pdf.js throws a PasswordException', async () => {
    class PasswordException extends Error {
      constructor() {
        super('password required')
        this.name = 'PasswordException'
      }
    }
    plan = { loadReject: new PasswordException() }
    const result = await callExtract()
    expect(result.status).toBe('unable_to_inspect')
    expect(result.reason).toBe('encrypted')
  })

  it('reports no-text-layer when the document has only whitespace text (scanned PDF)', async () => {
    plan = { pages: [['   ', '\t', ' \n ']] }
    const result = await callExtract()
    expect(result.status).toBe('unable_to_inspect')
    expect(result.reason).toBe('no-text-layer')
  })

  it('reports parse-error when pdf.js throws an unclassified error', async () => {
    plan = { loadReject: new Error('bogus') }
    const result = await callExtract()
    expect(result.status).toBe('unable_to_inspect')
    expect(result.reason).toBe('parse-error')
  })
})
