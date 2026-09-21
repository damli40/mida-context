import { describe, expect, it } from "vitest"
import { p256 } from "@noble/curves/nist.js"
import { sha256 } from "@noble/hashes/sha2.js"
import { P256_N } from "../../../packages/protocol/src/webauthn-assertion.js"
import { parseDerSignature } from "../src/check/der.js"
import { derSignature, makeKeyPair } from "./helpers.js"

describe("parseDerSignature", () => {
  it("parses a real DER signature into r and s", () => {
    const { privateKey } = makeKeyPair()
    const digest = sha256(new TextEncoder().encode("mida der test"))
    const der = p256.sign(digest, privateKey, { prehash: false, format: "der" })
    const parsed = parseDerSignature(der)
    const expected = p256.Signature.fromBytes(der, "der")
    expect(parsed.r).toBe(expected.r)
    expect(parsed.s).toBe(expected.s)
  })

  it("normalizes a high-s signature to its low-s twin, as packages/protocol does", () => {
    const { privateKey } = makeKeyPair()
    const digest = sha256(new TextEncoder().encode("mida der test"))
    const sig = p256.Signature.fromBytes(p256.sign(digest, privateKey, { prehash: false }), "compact")
    const highS = P256_N - sig.s
    expect(highS).toBeGreaterThan(P256_N / 2n)
    const parsed = parseDerSignature(derSignature(sig.r, highS))
    expect(parsed.s).toBe(sig.s)
    expect(parsed.s).toBeLessThanOrEqual(P256_N / 2n)
  })

  it("leaves an already low-s signature unchanged", () => {
    const { privateKey } = makeKeyPair()
    const digest = sha256(new TextEncoder().encode("mida der test"))
    const der = p256.sign(digest, privateKey, { prehash: false, format: "der" })
    const parsed = parseDerSignature(der)
    expect(parsed.s).toBeLessThanOrEqual(P256_N / 2n)
  })

  it("rejects non-DER input", () => {
    expect(() => parseDerSignature(new Uint8Array([0x00, 0x01, 0x02]))).toThrow()
    expect(() => parseDerSignature(new Uint8Array([0x30, 0x06, 0x02, 0x01]))).toThrow()
    expect(() => parseDerSignature(new Uint8Array(64).fill(7))).toThrow()
  })
})
