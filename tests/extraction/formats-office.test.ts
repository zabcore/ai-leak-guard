// @vitest-environment jsdom
//
// End-to-end tests for the OOXML extractors (docx, pptx, xlsx). We
// build the fixtures at test-setup time using the same libraries the
// extractors use (`jszip`, `xlsx`) rather than committing pre-built
// binary blobs. Advantages:
//   • no binary files to hand-audit in the repo
//   • sentinel strings are declared inline, so a diff shows what is
//     being extracted
//   • the fixtures always match the version of the parser we ship

import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import * as XLSX from 'xlsx'
import { extractText } from '../../src/content/extraction/extract'
import { docxXmlToText } from '../../src/content/extraction/formats/docx'
import { pptxSlideXmlToText } from '../../src/content/extraction/formats/pptx'

const DOCX_SENTINEL = 'SENTINEL_DOCX_FIXTURE_2026'
const PPTX_SENTINEL = 'SENTINEL_PPTX_FIXTURE_2026'
const XLSX_SENTINEL = 'SENTINEL_XLSX_FIXTURE_2026'

async function buildDocx(sentinel: string): Promise<File> {
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>${sentinel}</w:t></w:r></w:p>
    <w:p><w:r><w:t xml:space="preserve">second paragraph with a leading space:  </w:t></w:r><w:r><w:t>trail</w:t></w:r></w:p>
  </w:body>
</w:document>`
  const zip = new JSZip()
  zip.file('word/document.xml', doc)
  // A real .docx has more files (rels, content-types, etc). The
  // extractor only reads word/document.xml, so we ship the minimum.
  const bytes = await zip.generateAsync({ type: 'arraybuffer' })
  return new File([bytes], 'sentinel.docx', {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  })
}

async function buildPptx(sentinel: string): Promise<File> {
  const slide1 = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree>
    <p:sp><p:txBody><a:p><a:r><a:t>${sentinel}</a:t></a:r></a:p></p:txBody></p:sp>
  </p:spTree></p:cSld>
</p:sld>`
  const slide2 = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree>
    <p:sp><p:txBody><a:p><a:r><a:t>second slide</a:t></a:r></a:p></p:txBody></p:sp>
  </p:spTree></p:cSld>
</p:sld>`
  const zip = new JSZip()
  zip.file('ppt/slides/slide1.xml', slide1)
  zip.file('ppt/slides/slide2.xml', slide2)
  const bytes = await zip.generateAsync({ type: 'arraybuffer' })
  return new File([bytes], 'sentinel.pptx', {
    type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  })
}

function buildXlsx(sentinel: string): File {
  const wb = XLSX.utils.book_new()
  const ws = XLSX.utils.aoa_to_sheet([
    ['name', 'value'],
    ['sentinel', sentinel],
    ['patient', 'Jane Doe'],
  ])
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1')
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
  return new File([new Uint8Array(buf)], 'sentinel.xlsx', {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
}

describe('docx extractor', () => {
  it('extracts the sentinel from a synthesized .docx', async () => {
    const file = await buildDocx(DOCX_SENTINEL)
    const result = await extractText(file)
    expect(result.status).toBe('extracted')
    expect(result.text).toContain(DOCX_SENTINEL)
    expect(result.text).toContain('trail')
    expect(result.meta.detectedFormat).toBe('docx')
  })

  it('preserves paragraph breaks', () => {
    const xml = '<w:p><w:r><w:t>alpha</w:t></w:r></w:p><w:p><w:r><w:t>beta</w:t></w:r></w:p>'
    const text = docxXmlToText(xml)
    expect(text).toMatch(/alpha[\s\S]*\n[\s\S]*beta/)
  })

  it('decodes XML entities (&amp; &lt; &gt; &#39; numeric)', () => {
    const xml = '<w:p><w:r><w:t>&amp; &lt;x&gt; &#39;q&#39; &#65;</w:t></w:r></w:p>'
    expect(docxXmlToText(xml)).toContain("& <x> 'q' A")
  })

  it('reports empty for a document with no <w:t> content', async () => {
    const zip = new JSZip()
    zip.file('word/document.xml', '<w:document><w:body></w:body></w:document>')
    const bytes = await zip.generateAsync({ type: 'arraybuffer' })
    const file = new File([bytes], 'blank.docx', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    })
    const result = await extractText(file)
    expect(result.status).toBe('empty')
  })

  it('reports parse-error when a ZIP has no word/document.xml', async () => {
    const zip = new JSZip()
    zip.file('junk.txt', 'not a docx')
    const bytes = await zip.generateAsync({ type: 'arraybuffer' })
    const file = new File([bytes], 'junk.docx', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    })
    const result = await extractText(file)
    expect(result.status).toBe('unable_to_inspect')
    expect(result.reason).toBe('parse-error')
  })
})

describe('pptx extractor', () => {
  it('extracts text from all slides in numeric order', async () => {
    const file = await buildPptx(PPTX_SENTINEL)
    const result = await extractText(file)
    expect(result.status).toBe('extracted')
    expect(result.text).toContain(PPTX_SENTINEL)
    expect(result.text).toContain('second slide')
    // slide 1 sentinel appears before slide 2 body.
    expect(result.text.indexOf(PPTX_SENTINEL)).toBeLessThan(result.text.indexOf('second slide'))
  })

  it('minimal XML transformer preserves paragraph breaks', () => {
    const xml = '<a:p><a:r><a:t>x</a:t></a:r></a:p><a:p><a:r><a:t>y</a:t></a:r></a:p>'
    expect(pptxSlideXmlToText(xml)).toMatch(/x[\s\S]*\n[\s\S]*y/)
  })

  it('reports parse-error when a ZIP has no ppt/slides/slide*.xml', async () => {
    const zip = new JSZip()
    zip.file('junk.txt', 'not a pptx')
    const bytes = await zip.generateAsync({ type: 'arraybuffer' })
    const file = new File([bytes], 'junk.pptx', {
      type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    })
    const result = await extractText(file)
    expect(result.status).toBe('unable_to_inspect')
    expect(result.reason).toBe('parse-error')
  })
})

describe('xlsx extractor', () => {
  it('extracts sheet content as CSV — sentinel + PHI-shaped row appear', async () => {
    const file = buildXlsx(XLSX_SENTINEL)
    const result = await extractText(file)
    expect(result.status).toBe('extracted')
    expect(result.text).toContain(XLSX_SENTINEL)
    expect(result.text).toContain('Jane Doe')
    expect(result.meta.detectedFormat).toBe('xlsx')
  })
})
