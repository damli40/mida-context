import { hexToBytes } from "@noble/hashes/utils.js"
import { p256 } from "@noble/curves/nist.js"
import { sha256 } from "@noble/hashes/sha2.js"
import { concatBytes } from "@noble/hashes/utils.js"
import type { Hex } from "@mida/protocol"

export interface WebAuthnAssertionInput {
  authenticatorData: Hex
  clientDataJSON: string
  challengeIndex: string
  typeIndex: string
  r: Hex
  s: Hex
}

const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n
const FLAG_UP = 0x01
const FLAG_UV = 0x04

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

/**
 * Off-chain mirror of MidaWebAuthn plus webauthn-sol v1.0.0 (§10.4), used to accept a deny cancellation (§12.5):
 * RP-ID hash, UP and UV flags, `"type":"webauthn.get"` and the base64url challenge at their declared indexes,
 * low-s, then P256 over SHA-256(authenticatorData ‖ SHA-256(clientDataJSON)). Like the contract, it does not check
 * `clientDataJSON.origin`; the browser enforces the origin for the Vault RP ID.
 */
export function verifyVaultAssertion(input: {
  challenge: Hex
  assertion: WebAuthnAssertionInput
  qx: bigint
  qy: bigint
  rpIdHash: Hex
}): boolean {
  try {
    const { assertion } = input
    const authenticatorData = hexToBytes(assertion.authenticatorData.slice(2))
    if (authenticatorData.length < 37) return false
    if (Buffer.from(authenticatorData.subarray(0, 32)).toString("hex") !== input.rpIdHash.slice(2).toLowerCase()) return false
    const flags = authenticatorData[32]!
    if ((flags & FLAG_UP) === 0 || (flags & FLAG_UV) === 0) return false

    const typeIndex = Number(assertion.typeIndex)
    const challengeIndex = Number(assertion.challengeIndex)
    const expectedType = '"type":"webauthn.get"'
    if (assertion.clientDataJSON.slice(typeIndex, typeIndex + expectedType.length) !== expectedType) return false
    const expectedChallenge = `"challenge":"${base64url(hexToBytes(input.challenge.slice(2)))}"`
    if (assertion.clientDataJSON.slice(challengeIndex, challengeIndex + expectedChallenge.length) !== expectedChallenge) return false

    const r = BigInt(assertion.r)
    const s = BigInt(assertion.s)
    if (r <= 0n || r >= N || s <= 0n || s > N / 2n) return false

    const message = concatBytes(authenticatorData, sha256(new TextEncoder().encode(assertion.clientDataJSON)))
    const signature = hexToBytes(r.toString(16).padStart(64, "0") + s.toString(16).padStart(64, "0"))
    const publicKey = hexToBytes(`04${input.qx.toString(16).padStart(64, "0")}${input.qy.toString(16).padStart(64, "0")}`)
    return p256.verify(signature, message, publicKey, { prehash: true, lowS: true })
  } catch {
    return false
  }
}
