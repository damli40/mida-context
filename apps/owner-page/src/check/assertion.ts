import { sha256 } from "@noble/hashes/sha2.js"
import { p256 } from "@noble/curves/nist.js"
import { base64UrlEncode, bigIntToBytes32, concatBytes, equalBytes } from "./bytes.js"
import type { AuthenticatorDataInfo } from "./authdata.js"
import type { P256PublicKey } from "./spki.js"
import type { P256Signature } from "./der.js"
import { RP_ID, TEST_CHALLENGE } from "./constants.js"

/**
 * The WebAuthn signed message: authenticatorData ‖ SHA-256(clientDataJSON). The precompile takes
 * SHA-256 of that whole buffer as its `hash` input.
 */
export function assertionMessage(authenticatorData: Uint8Array, clientDataJSON: Uint8Array): Uint8Array {
  return concatBytes(authenticatorData, sha256(clientDataJSON))
}

export function assertionDigest(authenticatorData: Uint8Array, clientDataJSON: Uint8Array): Uint8Array {
  return sha256(assertionMessage(authenticatorData, clientDataJSON))
}

/** The 160-byte input for the P256VERIFY precompile: hash ‖ r ‖ s ‖ x ‖ y. */
export function buildPrecompileInput(digest32: Uint8Array, sig: P256Signature, pub: P256PublicKey): Uint8Array {
  if (digest32.length !== 32) throw new Error("digest must be 32 bytes")
  return concatBytes(digest32, bigIntToBytes32(sig.r), bigIntToBytes32(sig.s), pub.x, pub.y)
}

export interface BrowserVerification {
  signatureOk: boolean
  rpIdHashOk: boolean
  userVerifiedOk: boolean
  challengeOk: boolean
  ok: boolean
}

/**
 * The same checks the contract and apps/api apply — rpIdHash, the UV flag, then P-256 over
 * SHA-256(authenticatorData ‖ SHA-256(clientDataJSON)) — plus proof the authenticator really
 * signed OUR fixed test challenge, not the random one Mera generated.
 */
export function verifyAssertionInBrowser(input: {
  authenticatorData: Uint8Array
  authInfo: AuthenticatorDataInfo
  clientDataJSON: Uint8Array
  signature: P256Signature
  publicKey: P256PublicKey
  rpId?: string
  challenge?: Uint8Array
}): BrowserVerification {
  const rpId = input.rpId ?? RP_ID
  const challenge = input.challenge ?? TEST_CHALLENGE
  const rpIdHashOk = equalBytes(input.authInfo.rpIdHash, sha256(new TextEncoder().encode(rpId)))
  const userVerifiedOk = input.authInfo.userVerified

  let challengeOk = false
  try {
    const parsed = JSON.parse(new TextDecoder().decode(input.clientDataJSON)) as { challenge?: string }
    challengeOk = parsed.challenge === base64UrlEncode(challenge)
  } catch {
    challengeOk = false
  }

  const message = assertionMessage(input.authenticatorData, input.clientDataJSON)
  const compact = concatBytes(bigIntToBytes32(input.signature.r), bigIntToBytes32(input.signature.s))
  const point = concatBytes(new Uint8Array([0x04]), input.publicKey.x, input.publicKey.y)
  let signatureOk = false
  try {
    signatureOk = p256.verify(compact, message, point, { prehash: true, lowS: true })
  } catch {
    signatureOk = false
  }

  return { signatureOk, rpIdHashOk, userVerifiedOk, challengeOk, ok: signatureOk && rpIdHashOk && userVerifiedOk && challengeOk }
}
