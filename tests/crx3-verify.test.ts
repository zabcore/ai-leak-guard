// Self-hosted packaging — the CRX3 signature check used by `npm run pack:crx`.
// Builds CRX3 files in-process (no Chromium needed) and proves the verifier
// checks the real proof over signed header + archive, not mere key presence.

import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { verifyCrx3 } from '../scripts/crx3-verify.mjs'

function varint(n: number): Buffer {
  const out: number[] = []
  do {
    let b = n & 0x7f
    n >>>= 7
    if (n !== 0) b |= 0x80
    out.push(b)
  } while (n !== 0)
  return Buffer.from(out)
}
const field = (num: number, bytes: Buffer) =>
  Buffer.concat([varint((num << 3) | 2), varint(bytes.length), bytes])

function makeKey() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  return { privateKey, der: publicKey.export({ type: 'spki', format: 'der' }) as Buffer }
}

/** A minimal CRX3: one RSA proof, signed over the CRX3 SignedData input. */
function buildCrx(signer: ReturnType<typeof makeKey>, archive: Buffer, idKey = signer.der): Buffer {
  const signedHeaderData = field(1, createHash('sha256').update(idKey).digest().subarray(0, 16))
  const len = Buffer.alloc(4)
  len.writeUInt32LE(signedHeaderData.length)
  const signature = sign(
    'sha256',
    Buffer.concat([Buffer.from('CRX3 SignedData\x00', 'latin1'), len, signedHeaderData, archive]),
    signer.privateKey,
  )
  const header = Buffer.concat([
    field(2, Buffer.concat([field(1, signer.der), field(2, signature)])),
    field(10000, signedHeaderData),
  ])
  const prefix = Buffer.alloc(12)
  prefix.write('Cr24', 0, 'latin1')
  prefix.writeUInt32LE(3, 4)
  prefix.writeUInt32LE(header.length, 8)
  return Buffer.concat([prefix, header, archive])
}

// A ZIP local-file-header signature followed by arbitrary bytes is enough here.
const ARCHIVE = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(256, 7)])

describe('verifyCrx3', () => {
  const key = makeKey()
  const crx = buildCrx(key, ARCHIVE)

  it('accepts a CRX3 validly signed by the expected key', () => {
    expect(() => verifyCrx3(crx, key.der)).not.toThrow()
  })

  it('rejects a CRX truncated after its header (key still present)', () => {
    const headerEnd = 12 + crx.readUInt32LE(8)
    const truncated = crx.subarray(0, headerEnd)
    expect(truncated.indexOf(key.der)).toBeGreaterThan(-1)
    expect(() => verifyCrx3(truncated, key.der)).toThrow(/archive/)
    expect(() => verifyCrx3(crx.subarray(0, crx.length - 10), key.der)).toThrow(/signature/)
  })

  it('rejects a tampered archive byte', () => {
    const tampered = Buffer.from(crx)
    tampered[tampered.length - 1] ^= 0xff
    expect(() => verifyCrx3(tampered, key.der)).toThrow(/signature/)
  })

  it('rejects a CRX signed by a different key', () => {
    expect(() => verifyCrx3(buildCrx(makeKey(), ARCHIVE), key.der)).toThrow(/crx_id/)
  })

  it('rejects a mismatched signed crx_id even with a valid proof', () => {
    expect(() => verifyCrx3(buildCrx(key, ARCHIVE, makeKey().der), key.der)).toThrow(/crx_id/)
  })

  it('rejects non-CRX3 input', () => {
    expect(() => verifyCrx3(Buffer.from('PK\x03\x04zip'), key.der)).toThrow(/not a CRX/)
    const v2 = Buffer.from(crx)
    v2.writeUInt32LE(2, 4)
    expect(() => verifyCrx3(v2, key.der)).toThrow(/version 3/)
  })
})
