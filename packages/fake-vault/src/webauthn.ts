import { MidaError, toWebAuthnAuthStruct } from "@mida/protocol"
import type { Hex, WebAuthnAuthStruct } from "@mida/protocol"
import { p256 } from "@noble/curves/nist.js"
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js"
import { P256, WebAuthnP256 } from "ox"

/** WebAuthn-shaped metadata as ox builds it: authenticatorData, clientDataJSON and the field indexes webauthn-sol needs. */
export type VaultAssertionMetadata = ReturnType<typeof WebAuthnP256.getSignPayload>["metadata"]

/** JSON-safe form sent to the Context API for deny cancellation (§12.5). */
export interface WebAuthnAssertionWire {
  authenticatorData: Hex
  clientDataJSON: string
  challengeIndex: string
  typeIndex: string
  r: Hex
  s: Hex
}

const bytes32 = (value: bigint): Hex => `0x${value.toString(16).padStart(64, "0")}`

export function p256PublicKey(privateKey: Hex): { qx: bigint; qy: bigint } {
  const publicKey = P256.getPublicKey({ privateKey })
  return { qx: BigInt(publicKey.x), qy: BigInt(publicKey.y) }
}

/**
 * Spec §8: ox builds the metadata and the exact authenticator signing digest,
 * SHA-256(authenticatorData ‖ SHA-256(clientDataJSON)), for user verification required.
 */
export function vaultSignPayload(input: { challenge: Hex; rpId: string; origin: string }): { metadata: VaultAssertionMetadata; digest: Hex } {
  const { metadata, payload } = WebAuthnP256.getSignPayload({
    challenge: input.challenge,
    rpId: input.rpId,
    origin: input.origin,
    userVerification: "required",
    hash: true,
  })
  return { metadata, digest: payload }
}

/**
 * Converts a raw P256 signature over `vaultSignPayload`'s digest through the shared low-s adapter, then refuses to
 * return it unless ox `WebAuthnP256.verify` accepts the normalized assertion for this challenge, RP ID and origin.
 */
export function completeVaultAssertion(input: {
  challenge: Hex
  metadata: VaultAssertionMetadata
  r: bigint
  s: bigint
  publicKey: { qx: bigint; qy: bigint }
  rpId: string
  origin: string
}): WebAuthnAuthStruct {
  const { metadata } = input
  if (metadata.challengeIndex === undefined || metadata.typeIndex === undefined) {
    throw new MidaError("AUTH_INVALID", "assertion metadata lacks clientDataJSON challenge and type indexes")
  }
  const auth = toWebAuthnAuthStruct({
    authenticatorData: metadata.authenticatorData,
    clientDataJSON: metadata.clientDataJSON,
    challengeIndex: metadata.challengeIndex,
    typeIndex: metadata.typeIndex,
    r: input.r,
    s: input.s,
  })
  const verified = WebAuthnP256.verify({
    challenge: input.challenge,
    metadata,
    rpId: input.rpId,
    origin: input.origin,
    publicKey: { prefix: 4, x: bytes32(input.publicKey.qx), y: bytes32(input.publicKey.qy) },
    signature: { r: bytes32(auth.r), s: bytes32(auth.s), yParity: 0 },
  })
  if (!verified) throw new MidaError("AUTH_INVALID", "normalized assertion does not pass WebAuthnP256.verify")
  return auth
}

/**
 * Software passkey assertion (spec §8, §13.4): ox digest, a raw `@noble/curves` P256 signature with either s, the
 * shared low-s adapter, and an ox verification parity check.
 */
export function signVaultAssertion(input: { challenge: Hex; privateKey: Hex; rpId: string; origin: string }): WebAuthnAuthStruct {
  const { metadata, digest } = vaultSignPayload(input)
  const raw = p256.sign(hexToBytes(digest.slice(2)), hexToBytes(input.privateKey.slice(2)), { prehash: false, lowS: false })
  return completeVaultAssertion({
    challenge: input.challenge,
    metadata,
    r: BigInt(`0x${bytesToHex(raw.slice(0, 32))}`),
    s: BigInt(`0x${bytesToHex(raw.slice(32))}`),
    publicKey: p256PublicKey(input.privateKey),
    rpId: input.rpId,
    origin: input.origin,
  })
}

export function assertionToWire(auth: WebAuthnAuthStruct): WebAuthnAssertionWire {
  return {
    authenticatorData: auth.authenticatorData,
    clientDataJSON: auth.clientDataJSON,
    challengeIndex: auth.challengeIndex.toString(10),
    typeIndex: auth.typeIndex.toString(10),
    r: bytes32(auth.r),
    s: bytes32(auth.s),
  }
}
