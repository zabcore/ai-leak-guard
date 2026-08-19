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
}

export type BoundedReadResult =
  | { readonly kind: 'text'; readonly text: string; readonly bytesRead: number }
  | { readonly kind: 'over-cap'; readonly bytesRead: number }
  | { readonly kind: 'stream-error'; readonly err: unknown }

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

    const settle = (result: BoundedReadResult): void => {
      if (settled) return
      settled = true
      try {
        stream.pause?.()
      } catch {
        // Ignore — settle path must never throw.
      }
      resolve(result)
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
      const text = new TextDecoder('utf-8', { fatal: false }).decode(merged)
      settle({ kind: 'text', text, bytesRead })
    })

    // JSZip's stream is paused by default; kick it.
    stream.resume()
  })
}

interface JszipStream<T> {
  on(event: 'data', cb: (chunk: T) => void): this
  on(event: 'error', cb: (err: unknown) => void): this
  on(event: 'end', cb: () => void): this
  resume(): this
  pause?: () => this
}
