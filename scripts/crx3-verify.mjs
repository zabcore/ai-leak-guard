// Verify a CRX3 file's signature against an expected RSA public key.
//
// CRX3 layout (components/crx_file/crx3.proto):
//   "Cr24" | u32le version=3 | u32le header_size | CrxFileHeader | ZIP archive
// CrxFileHeader:  2 = sha256_with_rsa (repeated AsymmetricKeyProof)
//                 3 = sha256_with_ecdsa (repeated AsymmetricKeyProof)
//             10000 = signed_header_data (bytes; a SignedData message)
// AsymmetricKeyProof: 1 = public_key (DER SPKI), 2 = signature
// SignedData:         1 = crx_id (first 16 bytes of SHA-256(public_key))
// Each proof signs:  "CRX3 SignedData\x00" | u32le len(signed_header_data)
//                    | signed_header_data | archive

import { createHash, createPublicKey, verify } from 'node:crypto'

/** Parse a protobuf message into { fieldNumber: [values] } (varint + bytes only). */
function parseProto(buf) {
  const fields = {}
  let i = 0
  const varint = () => {
    let result = 0n
    let shift = 0n
    for (;;) {
      if (i >= buf.length) throw new Error('truncated varint')
      const b = buf[i++]
      result |= BigInt(b & 0x7f) << shift
      if ((b & 0x80) === 0) return result
      shift += 7n
    }
  }
  while (i < buf.length) {
    const key = varint()
    const field = Number(key >> 3n)
    const wire = Number(key & 7n)
    let value
    if (wire === 0) value = varint()
    else if (wire === 2) {
      const len = Number(varint())
      if (i + len > buf.length) throw new Error('truncated field')
      value = buf.subarray(i, i + len)
      i += len
    } else throw new Error(`unsupported wire type ${wire}`)
    ;(fields[field] ??= []).push(value)
  }
  return fields
}

/**
 * Throws unless `crx` is a well-formed CRX3 whose RSA proof for `expectedDer`
 * verifies over the signed header data + the complete archive, and whose
 * signed crx_id matches that key.
 */
export function verifyCrx3(crx, expectedDer) {
  if (crx.length < 12 || crx.subarray(0, 4).toString('latin1') !== 'Cr24') {
    throw new Error('not a CRX file')
  }
  if (crx.readUInt32LE(4) !== 3) throw new Error('not CRX version 3')
  const headerSize = crx.readUInt32LE(8)
  if (12 + headerSize > crx.length) throw new Error('header exceeds file size')
  const header = parseProto(crx.subarray(12, 12 + headerSize))
  const archive = crx.subarray(12 + headerSize)
  if (archive.length < 4 || archive.readUInt32LE(0) !== 0x04034b50) {
    throw new Error('archive is missing or not a ZIP')
  }

  const signedHeaderData = header[10000]?.[0]
  if (!signedHeaderData) throw new Error('no signed_header_data')
  const crxId = parseProto(signedHeaderData)[1]?.[0]
  const expectedId = createHash('sha256').update(expectedDer).digest().subarray(0, 16)
  if (!crxId || !Buffer.from(crxId).equals(expectedId)) {
    throw new Error('signed crx_id does not match the expected key')
  }

  const proof = (header[2] ?? [])
    .map(parseProto)
    .find((p) => p[1]?.[0] && Buffer.from(p[1][0]).equals(expectedDer))
  if (!proof?.[2]?.[0]) throw new Error('no RSA proof for the expected key')

  const len = Buffer.alloc(4)
  len.writeUInt32LE(signedHeaderData.length)
  const signed = Buffer.concat([
    Buffer.from('CRX3 SignedData\x00', 'latin1'),
    len,
    signedHeaderData,
    archive,
  ])
  const key = createPublicKey({ key: Buffer.from(expectedDer), format: 'der', type: 'spki' })
  if (!verify('sha256', signed, key, proof[2][0])) {
    throw new Error('RSA signature does not verify')
  }
}
