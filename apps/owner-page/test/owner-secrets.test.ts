import { describe, expect, it } from "vitest"
import { privateKeyToAccount } from "viem/accounts"
import { bytesToHex } from "../src/check/bytes.js"
import {
  OWNER_PRF_SALT,
  deriveOwnerSecrets,
  ownerAccount,
  ownerAddressOf,
  shortAddress,
} from "../src/owner/secrets.js"

/**
 * Known-answer pinning of the frozen derivation. These constants are load-bearing: every
 * registered owner's identity is passkey → PRF output → these two HKDF labels. If this test ever
 * has to change its expected values, that change orphans every owner — it is a migration, not a
 * refactor. The expected hex was produced by an independent `node` eval of the same HKDF calls.
 */
const PRF = new Uint8Array(32).map((_, i) => i + 1) // 01 02 … 20 — arbitrary test secret

describe("the frozen owner derivation", () => {
  it("pins the PRF salt", () => {
    expect(bytesToHex(OWNER_PRF_SALT)).toBe("2483cd5e95c244d43803413f8ac87d779aff08435b16f7f8970a8dfc768ae3db")
  })

  it("pins the evm key, the owner seed, and the owner address", () => {
    const secrets = deriveOwnerSecrets(PRF.slice())
    expect(bytesToHex(secrets.evmKey)).toBe("ff438704dec5c3231fda17affd19ebde6245f812e6b738a2af60140b383b3d33")
    expect(bytesToHex(secrets.ownerSeed)).toBe("d370af776cde7e53d7a51a6ad109a01ce2c26e2ca5dafd21b23e6685ba011ade")
    expect(ownerAddressOf(secrets)).toBe("0xd148086f168529c605e4826f09d7a35619c87397")
  })

  it("derives the same secrets twice from the same PRF output — determinism is the whole design", () => {
    const a = deriveOwnerSecrets(PRF.slice())
    const b = deriveOwnerSecrets(PRF.slice())
    expect(bytesToHex(a.evmKey)).toBe(bytesToHex(b.evmKey))
    expect(bytesToHex(a.ownerSeed)).toBe(bytesToHex(b.ownerSeed))
  })

  it("consumes the PRF buffer — after derive, the only reachable secret bytes are on the result", () => {
    const prf = PRF.slice()
    const secrets = deriveOwnerSecrets(prf)
    expect(prf.every((b) => b === 0)).toBe(true)
    expect(bytesToHex(secrets.evmKey)).not.toBe("00".repeat(32))
  })

  it("refuses a short or all-zero PRF output, and does NOT touch the input on refusal", () => {
    const short = new Uint8Array(31)
    const zero = new Uint8Array(32)
    expect(() => deriveOwnerSecrets(short)).toThrowError(/32 non-zero/)
    expect(() => deriveOwnerSecrets(zero)).toThrowError(/32 non-zero/)
    expect(zero.some((b) => b !== 0)).toBe(false) // it was zero anyway — the point is no partial write
  })
})

describe("release", () => {
  it("overwrites both buffers, marks the object released, and is idempotent", () => {
    const secrets = deriveOwnerSecrets(PRF.slice())
    expect(secrets.released).toBe(false)
    secrets.release()
    expect(secrets.released).toBe(true)
    expect(secrets.evmKey.every((b) => b === 0)).toBe(true)
    expect(secrets.ownerSeed.every((b) => b === 0)).toBe(true)
    expect(() => secrets.release()).not.toThrow()
  })

  it("ownerAccount refuses to sign once released", () => {
    const secrets = deriveOwnerSecrets(PRF.slice())
    secrets.release()
    expect(() => ownerAccount(secrets)).toThrowError(/released/)
  })

  it("ownerAccount returns a real signer over the derived key", async () => {
    const secrets = deriveOwnerSecrets(PRF.slice())
    const account = ownerAccount(secrets)
    expect(account.address.toLowerCase()).toBe(ownerAddressOf(secrets))
    const signature = await account.signMessage({ message: "mida test" })
    expect(signature.startsWith("0x")).toBe(true)
    // sanity: viem derives the same address from the same key bytes directly
    expect(account.address).toBe(privateKeyToAccount(`0x${bytesToHex(secrets.evmKey)}`).address)
  })
})

describe("shortAddress", () => {
  it("abbreviates for the wrong-owner message", () => {
    expect(shortAddress("0xD148086f168529c605e4826f09D7a35619C87397")).toBe("0xD148…7397")
    expect(shortAddress("0x1234")).toBe("0x1234")
  })
})
