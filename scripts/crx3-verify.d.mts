/** Throws unless `crx` is a CRX3 validly signed by the RSA key `expectedDer` (DER SPKI). */
export function verifyCrx3(crx: Buffer, expectedDer: Buffer): void
