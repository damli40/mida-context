import type { Hex } from "viem"
import { MidaError } from "./errors.js"

/** Order of the P256 (secp256r1) group. */
export const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n

/** Solidity `WebAuthn.WebAuthnAuth` from webauthn-sol v1.0.0, in field order. */
export interface WebAuthnAuthStruct {
  authenticatorData: Hex
  clientDataJSON: string
  challengeIndex: bigint
  typeIndex: bigint
  r: bigint
  s: bigint
}

/**
 * EIP-7951 accepts any 0 < s < n, but webauthn-sol rejects s > n/2 (spec §10.4). A valid signature with high s has an
 * equally valid twin at n - s, so every adapter maps to that low-s form before contract submission.
 */
export function normalizeP256LowS(s: bigint): bigint {
  if (s <= 0n || s >= P256_N) throw new MidaError("INVALID_WIRE", "P256 signature s must satisfy 0 < s < n")
  return s > P256_N / 2n ? P256_N - s : s
}

/**
 * The shared assertion adapter (spec §10.4, §15): builds the struct `grantBatch` and `rotateP256Key` consume, with s
 * normalized. It has no FakeVault or browser dependency, so Project 2's real passkey adapter uses exactly this.
 */
export function toWebAuthnAuthStruct(input: {
  authenticatorData: Hex
  clientDataJSON: string
  challengeIndex: number | bigint
  typeIndex: number | bigint
  r: bigint
  s: bigint
}): WebAuthnAuthStruct {
  return {
    authenticatorData: input.authenticatorData,
    clientDataJSON: input.clientDataJSON,
    challengeIndex: BigInt(input.challengeIndex),
    typeIndex: BigInt(input.typeIndex),
    r: input.r,
    s: normalizeP256LowS(input.s),
  }
}
