// Shared XML-entity decoder for the OOXML text extractors (docx,
// pptx). Kept in one place so we only have to validate the numeric
// code-point range once: `String.fromCodePoint` throws `RangeError`
// for values above `0x10FFFF` or negative values. An OOXML document
// with a hostile `&#x110000;` reference would otherwise crash the
// extractor and be classified as `parse-error` for the whole file —
// we prefer to keep parsing and drop the offending entity.

export function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => safeCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n: string) => safeCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&')
}

function safeCodePoint(cp: number): string {
  // XML 1.0 §2.2 defines the legal character set:
  //   #x9 | #xA | #xD | [#x20-#xD7FF] | [#xE000-#xFFFD] | [#x10000-#x10FFFF]
  // Anything outside that range (control chars like U+0000, surrogate
  // halves, U+FFFE / U+FFFF) is not a legal XML character; a numeric
  // reference that points there is almost certainly a hostile probe.
  // Drop the character rather than embedding an invalid codepoint in
  // the extracted text (which would later confuse the detector or the
  // event log).
  const isXmlCharacter =
    cp === 0x9 ||
    cp === 0xa ||
    cp === 0xd ||
    (cp >= 0x20 && cp <= 0xd7ff) ||
    (cp >= 0xe000 && cp <= 0xfffd) ||
    (cp >= 0x10000 && cp <= 0x10ffff)
  if (!Number.isFinite(cp) || !isXmlCharacter) return ''
  return String.fromCodePoint(cp)
}
