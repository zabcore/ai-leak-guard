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
  // Unicode Standard: code points range from U+0000 to U+10FFFF.
  // Surrogate halves (U+D800..U+DFFF) are technically valid code
  // points but not scalar values; passing them into
  // `String.fromCodePoint` produces a lone surrogate string. We
  // filter them out so callers never see invalid UTF-16.
  if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return ''
  if (cp >= 0xd800 && cp <= 0xdfff) return ''
  return String.fromCodePoint(cp)
}
