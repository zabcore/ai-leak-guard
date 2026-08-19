// Bounded ZIP-entry decompression for the OOXML extractors.
//
// Why not `entry.async('string')`? JSZip's `.async()` accumulates the
// ENTIRE decompressed output before returning; its own uncompressed-
// size sanity check runs only after decompression. So a hostile
// archive with a falsified `_data.uncompressedSize` header (or none)
// can still allocate gigabytes before jszip notices. A pre-parse
// check on the declared size — like the earlier `docx.ts` /
// `pptx.ts` guard — is fine for HONEST archives but is trivially
// defeated by an attacker who omits or lies about the size.
//
// `entry.internalStream('uint8array')` emits chunks as decompression
// runs and gives us the hook to `.pause()` (and reject) as soon as
// the running total crosses a cap. This is what makes the memory
// bound actually enforceable.
//
// Result contract:
//   • `{ kind: 'text', text }` — entry decompressed successfully and
//     under `cap` bytes. Bytes are UTF-8 decoded.
//   • `{ kind: 'over-cap', bytesRead }` — cap was crossed; caller
//     maps this to `{ kind: 'reason', reason: 'too-large' }`.
//   • `{ kind: 'stream-error', err }` — jszip stream raised an
//     error; caller maps to `parse-error`.

import type JSZip from 'jszip'

export interface BoundedReadOptions {
  /** Maximum uncompressed bytes to accept before aborting the stream. */
  readonly cap: number
  /**
   * When `true` (the default), an entry with no declared
   * `_data.uncompressedSize` in the central directory is rejected as
   * `over-cap` before decompression starts — fail-closed, so a ZIP
   * that lies by omission cannot slip past the cap. Set to `false`
   * only if you have another out-of-band assurance that the entry is
   * small.
   */
  readonly failClosedIfUnknownSize?: boolean
  /**
   * Extraction-level cancellation (from `extract.ts`'s 10 s timer).
   * When aborted mid-stream we pause the jszip reader and settle
   * with `{ kind: 'aborted' }` so a hostile OOXML entry can't keep
   * consuming CPU / memory after the request deadline has passed.
   */
  readonly signal?: AbortSignal
}

export type BoundedReadResult =
  | { readonly kind: 'text'; readonly text: string; readonly bytesRead: number }
  | { readonly kind: 'over-cap'; readonly bytesRead: number }
  | { readonly kind: 'stream-error'; readonly err: unknown }
  | { readonly kind: 'aborted'; readonly bytesRead: number }

/**
 * The private `_data` shape jszip carries on entries loaded from a
 * container (documented behaviour but not on the public .d.ts).
 * `uncompressedSize` is the value from the ZIP central directory.
 */
type JszipEntryData = { _data?: { uncompressedSize?: number } }

export function declaredUncompressedSize(entry: JSZip.JSZipObject): number | null {
  const rec = (entry as unknown as JszipEntryData)._data
  if (!rec) return null
  const n = rec.uncompressedSize
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return null
  return n
}

/**
 * Read one JSZip entry into a UTF-8 string, capping the decompressed
 * output at `cap` bytes. Pauses (and rejects with `over-cap`) the
 * moment a chunk pushes the running total over the cap — memory use
 * stays bounded even if the underlying compressed data would inflate
 * to gigabytes.
 */
export function readEntryBoundedText(
  entry: JSZip.JSZipObject,
  opts: BoundedReadOptions,
): Promise<BoundedReadResult> {
  const cap = opts.cap
  const failClosed = opts.failClosedIfUnknownSize !== false

  // Fail-closed pre-check on the declared size. This is a fast reject
  // for the honest-archive case; the streaming check below is what
  // catches a header that lies (declared: 100 KB, actual: 500 MB).
  const declared = declaredUncompressedSize(entry)
  if (declared === null && failClosed) {
    return Promise.resolve({ kind: 'over-cap', bytesRead: 0 })
  }
  if (declared !== null && declared > cap) {
    return Promise.resolve({ kind: 'over-cap', bytesRead: declared })
  }

  // Fast path: if the caller has already aborted before we even
  // create the stream, don't touch jszip.
  if (opts.signal?.aborted) {
    return Promise.resolve({ kind: 'aborted', bytesRead: 0 })
  }

  return new Promise((resolve) => {
    // JSZip's stream helper: `.on('data', ...)` yields decompressed
    // chunks; `.on('error')` / `.on('end')` terminate. `resume()`
    // starts the pump. Typed loosely because jszip's public .d.ts
    // does not expose `internalStream`; the runtime API is stable and
    // documented (`https://stuk.github.io/jszip/documentation/api_zipobject/internalstream.html`).
    const stream = (
      entry as unknown as {
        internalStream: (type: 'uint8array') => JszipStream<Uint8Array>
      }
    ).internalStream('uint8array')

    let bytesRead = 0
    let settled = false
    const chunks: Uint8Array[] = []
    let onAbort: (() => void) | null = null

    const settle = (result: BoundedReadResult): void => {
      if (settled) return
      settled = true
      try {
        stream.pause?.()
      } catch {
        // Ignore — settle path must never throw.
      }
      if (onAbort && opts.signal) {
        opts.signal.removeEventListener('abort', onAbort)
      }
      resolve(result)
    }

    // Wire the extraction timeout: on abort, pause the jszip stream
    // and settle immediately. Without this, docx/pptx would keep
    // decompressing past the 10 s deadline (PDF already gets the
    // signal via its own path).
    if (opts.signal) {
      onAbort = (): void => {
        settle({ kind: 'aborted', bytesRead })
      }
      opts.signal.addEventListener('abort', onAbort, { once: true })
    }

    stream.on('data', (chunk: Uint8Array) => {
      if (settled) return
      bytesRead += chunk.byteLength
      if (bytesRead > cap) {
        settle({ kind: 'over-cap', bytesRead })
        return
      }
      chunks.push(chunk)
    })
    stream.on('error', (err: unknown) => {
      settle({ kind: 'stream-error', err })
    })
    stream.on('end', () => {
      if (settled) return
      const merged = new Uint8Array(bytesRead)
      let offset = 0
      for (const c of chunks) {
        merged.set(c, offset)
        offset += c.byteLength
      }
      settle({ kind: 'text', text: decodeXmlBytes(merged), bytesRead })
    })

    // JSZip's stream is paused by default; kick it.
    stream.resume()
  })
}

/**
 * Decode bounded ZIP-entry bytes as XML text, handling the encodings
 * the Open Packaging Conventions (§10.1.2 / ECMA-376 Part 2) permit
 * for XML parts: **UTF-8 or UTF-16**. Anything else is forbidden by
 * OPC, so we don't attempt more exotic detection.
 *
 * BOM-first dispatch:
 *   FF FE     → UTF-16 LE
 *   FE FF     → UTF-16 BE
 *   EF BB BF  → UTF-8 (BOM stripped)
 *   otherwise → UTF-8 (the common case; MS Word / PowerPoint write
 *               UTF-8 without a BOM)
 *
 * `TextDecoder` with `ignoreBOM: false` (the constructor default)
 * STRIPS the BOM from the output — that's the behaviour we want so
 * the extracted text doesn't start with a stray U+FEFF that could
 * confuse the `<w:t>` / `<a:t>` regexes. (For contrast: passing
 * `ignoreBOM: true` would PRESERVE the BOM in the output.)
 *
 * Exported for direct unit-testing.
 */
export function decodeXmlBytes(bytes: Uint8Array): string {
  const encoding = detectEncoding(bytes)
  return new TextDecoder(encoding, { fatal: false }).decode(bytes)
}

function detectEncoding(bytes: Uint8Array): 'utf-8' | 'utf-16le' | 'utf-16be' {
  if (bytes.length >= 2) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le'
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be'
  }
  // UTF-8 BOM is EF BB BF; `ignoreBOM: true` on the decoder strips it.
  return 'utf-8'
}

interface JszipStream<T> {
  on(event: 'data', cb: (chunk: T) => void): this
  on(event: 'error', cb: (err: unknown) => void): this
  on(event: 'end', cb: () => void): this
  resume(): this
  pause?: () => this
}
