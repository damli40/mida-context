import { normalizeP256LowS } from "../../../../packages/protocol/src/webauthn-assertion.js"

/**
 * ECDSA signature parsing — `AuthenticatorAssertionResponse.signature` is ASN.1 DER:
 * SEQUENCE { INTEGER r, INTEGER s }, each integer possibly carrying a leading 0x00 sign pad.
 *
 * s is normalized to its low-s twin through the exact helper packages/protocol uses for the
 * contract (imported by file so the page bundle does not pull in protocol's viem-using index).
 */
export interface P256Signature {
  r: bigint
  s: bigint
}

function readLen(buf: Uint8Array, pos: number): { len: number; pos: number } | null {
  if (pos >= buf.length) return null
  let len = buf[pos]!
  pos += 1
  if (len & 0x80) {
    const lenBytes = len & 0x7f
    if (lenBytes === 0 || lenBytes > 2 || pos + lenBytes > buf.length) return null
    len = 0
    for (let i = 0; i < lenBytes; i++) len = (len << 8) | buf[pos + i]!
    pos += lenBytes
  }
  return { len, pos }
}

function readInteger(buf: Uint8Array, pos: number): { value: bigint; next: number } | null {
  if (pos >= buf.length || buf[pos] !== 0x02) return null
  const head = readLen(buf, pos + 1)
  if (!head) return null
  const end = head.pos + head.len
  if (end > buf.length || head.len === 0) return null
  let value = 0n
  for (let i = head.pos; i < end; i++) value = (value << 8n) | BigInt(buf[i]!)
  return { value, next: end }
}

/** Parses a DER ECDSA signature and returns (r, s) with s already in low-s form. Throws on malformed input. */
export function parseDerSignature(der: Uint8Array): P256Signature {
  if (der.length < 8 || der[0] !== 0x30) throw new Error("not a DER sequence")
  const head = readLen(der, 1)
  if (!head || head.pos + head.len !== der.length) throw new Error("bad DER length")
  const r = readInteger(der, head.pos)
  const s = r && readInteger(der, r.next)
  if (!r || !s || s.next !== der.length) throw new Error("expected INTEGER r, INTEGER s")
  return { r: r.value, s: normalizeP256LowS(s.value) }
}
