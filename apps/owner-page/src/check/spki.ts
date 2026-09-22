/**
 * SubjectPublicKeyInfo parsing — just enough DER to find the EC point a P-256 credential reports
 * through `AuthenticatorAttestationResponse.getPublicKey()`.
 *
 *   SEQUENCE { algorithm SEQUENCE { OID ecPublicKey, OID prime256v1 }, BIT STRING { 0x00, 0x04, x, y } }
 *
 * Anything that does not match that shape (RSA SPKI, a truncated buffer) returns null — the page
 * reports UNKNOWN rather than guessing.
 */

export interface P256PublicKey {
  x: Uint8Array
  y: Uint8Array
}

const OID_EC_PUBLIC_KEY = [0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01]
const OID_PRIME256V1 = [0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07]

interface Tlv {
  tag: number
  start: number
  end: number
  next: number
}

function readTlv(buf: Uint8Array, offset: number): Tlv | null {
  if (offset + 2 > buf.length) return null
  const tag = buf[offset]!
  let len = buf[offset + 1]!
  let pos = offset + 2
  if (len & 0x80) {
    const lenBytes = len & 0x7f
    if (lenBytes === 0 || lenBytes > 2 || pos + lenBytes > buf.length) return null
    len = 0
    for (let i = 0; i < lenBytes; i++) len = (len << 8) | buf[pos + i]!
    pos += lenBytes
  }
  const end = pos + len
  if (end > buf.length) return null
  return { tag, start: pos, end, next: end }
}

function slice(buf: Uint8Array, tlv: Tlv): Uint8Array {
  return buf.subarray(tlv.start, tlv.end)
}

function matchesPrefix(buf: Uint8Array, expected: number[]): boolean {
  if (buf.length < expected.length) return false
  return expected.every((b, i) => buf[i] === b)
}

/** Returns the uncompressed P-256 point from a credential's SPKI, or null when the key is not EC P-256. */
export function parseP256Spki(spki: Uint8Array): P256PublicKey | null {
  const outer = readTlv(spki, 0)
  if (!outer || outer.tag !== 0x30 || outer.next !== spki.length) return null

  const algSeq = readTlv(spki, outer.start)
  if (!algSeq || algSeq.tag !== 0x30) return null
  const bitString = readTlv(spki, algSeq.next)
  if (!bitString || bitString.tag !== 0x03 || bitString.next !== outer.end) return null

  const alg = slice(spki, algSeq)
  if (!matchesPrefix(alg, OID_EC_PUBLIC_KEY)) return null
  const oid2 = readTlv(alg, OID_EC_PUBLIC_KEY.length)
  if (!oid2 || oid2.tag !== 0x06) return null
  if (!matchesPrefix(alg.subarray(oid2.start, oid2.end), OID_PRIME256V1.slice(2))) return null

  const point = slice(spki, bitString)
  if (point.length !== 66 || point[0] !== 0x00 || point[1] !== 0x04) return null
  return { x: point.slice(2, 34), y: point.slice(34, 66) }
}
