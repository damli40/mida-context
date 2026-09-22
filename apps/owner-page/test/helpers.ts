import { p256 } from "@noble/curves/nist.js"
import { sha256 } from "@noble/hashes/sha2.js"
import { base64UrlEncode, concatBytes } from "../src/check/bytes.js"
import { FLAG_UP, FLAG_UV, RP_ID, TEST_CHALLENGE } from "../src/check/constants.js"

/**
 * Synthetic WebAuthn vectors generated with @noble/curves — the same shapes a real authenticator
 * returns, produced deterministically inside the test so every parser runs on realistic bytes.
 */

/** DER prefix of a P-256 SubjectPublicKeyInfo — everything before the 65-byte uncompressed point. */
export const P256_SPKI_PREFIX = new Uint8Array([
  0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce,
  0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
])

export function makeKeyPair() {
  const privateKey = p256.utils.randomSecretKey()
  const point = p256.getPublicKey(privateKey, false) // 0x04 ‖ x ‖ y
  return {
    privateKey,
    x: point.slice(1, 33),
    y: point.slice(33, 65),
    spki: concatBytes(P256_SPKI_PREFIX, point),
  }
}

export function makeAuthenticatorData(rpId: string = RP_ID, flags: number = FLAG_UP | FLAG_UV): Uint8Array {
  const out = new Uint8Array(37)
  out.set(sha256(new TextEncoder().encode(rpId)), 0)
  out[32] = flags
  out[36] = 1 // signCount = 1
  return out
}

export function makeClientDataJSON(challenge: Uint8Array = TEST_CHALLENGE): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      type: "webauthn.get",
      challenge: base64UrlEncode(challenge),
      origin: `https://${RP_ID}`,
      crossOrigin: false,
    }),
  )
}

export interface SyntheticAssertion {
  authenticatorData: Uint8Array
  clientDataJSON: Uint8Array
  signatureDer: Uint8Array
  messageDigest: Uint8Array
}

/** A real P-256 signature over a synthetic WebAuthn assertion, DER-encoded as WebAuthn delivers it. */
export function makeAssertion(privateKey: Uint8Array, opts: { flags?: number; challenge?: Uint8Array; rpId?: string } = {}): SyntheticAssertion {
  const authenticatorData = makeAuthenticatorData(opts.rpId, opts.flags)
  const clientDataJSON = makeClientDataJSON(opts.challenge)
  const messageDigest = sha256(concatBytes(authenticatorData, sha256(clientDataJSON)))
  const signatureDer = p256.sign(messageDigest, privateKey, { prehash: false, format: "der" })
  return { authenticatorData, clientDataJSON, signatureDer, messageDigest }
}

/** DER INTEGER encoding — used to build a deliberately high-s signature. */
export function derInteger(value: bigint): Uint8Array {
  let hex = value.toString(16)
  if (hex.length % 2) hex = "0" + hex
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  const padded = bytes[0]! & 0x80 ? concatBytes(new Uint8Array([0x00]), bytes) : bytes
  return concatBytes(new Uint8Array([0x02, padded.length]), padded)
}

export function derSignature(r: bigint, s: bigint): Uint8Array {
  const body = concatBytes(derInteger(r), derInteger(s))
  return concatBytes(new Uint8Array([0x30, body.length]), body)
}
