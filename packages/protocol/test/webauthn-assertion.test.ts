import { describe, expect, it } from "vitest"
import { P256, WebAuthnP256 } from "ox"
import type { Hex } from "@mida/protocol"
import { P256_N, isMidaError, normalizeP256LowS, toWebAuthnAuthStruct } from "@mida/protocol"

const HALF = P256_N / 2n
const bytes32 = (value: bigint): Hex => `0x${value.toString(16).padStart(64, "0")}`

const invalid = (fn: () => unknown) => {
  try {
    fn()
  } catch (error) {
    return isMidaError(error, "INVALID_WIRE")
  }
  return false
}

describe("shared P256 low-s assertion adapter (§10.4)", () => {
  it("fixes the P256 group order", () => {
    expect(P256_N).toBe(0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n)
  })

  it("maps a high-s value to n - s", () => {
    expect(normalizeP256LowS(HALF + 1n)).toBe(P256_N - HALF - 1n)
    expect(normalizeP256LowS(P256_N - 1n)).toBe(1n)
  })

  it("leaves low-s and exactly n/2 untouched", () => {
    expect(normalizeP256LowS(1n)).toBe(1n)
    expect(normalizeP256LowS(HALF - 1n)).toBe(HALF - 1n)
    expect(normalizeP256LowS(HALF)).toBe(HALF)
  })

  it("rejects zero, negative values, n and anything above n", () => {
    for (const s of [0n, -1n, P256_N, P256_N + 1n]) expect(invalid(() => normalizeP256LowS(s)), s.toString()).toBe(true)
  })

  it("builds the webauthn-sol struct with normalized s, and an ox-verified assertion stays valid", () => {
    const privateKey: Hex = `0x${"4d".repeat(32)}`
    const publicKey = P256.getPublicKey({ privateKey })
    const challenge: Hex = `0x${"ab".repeat(32)}`
    const rpId = "vault.mida.xyz"
    const origin = "https://vault.mida.xyz"
    const { metadata, payload } = WebAuthnP256.getSignPayload({ challenge, rpId, origin, userVerification: "required" })
    const signature = P256.sign({ payload, privateKey, hash: true })
    const verifies = (r: bigint, s: bigint) =>
      WebAuthnP256.verify({ challenge, metadata, publicKey, rpId, origin, signature: { r: bytes32(r), s: bytes32(s), yParity: 0 } })
    const r = BigInt(signature.r)
    expect(verifies(r, BigInt(signature.s))).toBe(true)

    const lowS = normalizeP256LowS(BigInt(signature.s))
    for (const rawS of [lowS, P256_N - lowS]) {
      const auth = toWebAuthnAuthStruct({
        authenticatorData: metadata.authenticatorData,
        clientDataJSON: metadata.clientDataJSON,
        challengeIndex: metadata.challengeIndex!,
        typeIndex: metadata.typeIndex!,
        r,
        s: rawS,
      })
      expect(auth).toEqual({
        authenticatorData: metadata.authenticatorData,
        clientDataJSON: metadata.clientDataJSON,
        challengeIndex: BigInt(metadata.challengeIndex!),
        typeIndex: BigInt(metadata.typeIndex!),
        r,
        s: lowS,
      })
      expect(auth.s <= HALF).toBe(true)
      expect(verifies(auth.r, auth.s)).toBe(true)
    }
  })
})
