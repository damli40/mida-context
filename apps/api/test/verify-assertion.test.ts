import { describe, expect, it } from "vitest"
import { p256 } from "@noble/curves/nist.js"
import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js"
import type { Hex } from "@mida/protocol"
import { assertionToWire, p256PublicKey, signVaultAssertion } from "@mida/fake-vault"
import type { WebAuthnAssertionWire } from "@mida/fake-vault"
import { verifyVaultAssertion } from "@mida/api"

const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n
const KEY: Hex = `0x${"4d".repeat(32)}`
const OTHER_KEY: Hex = `0x${"4e".repeat(32)}`
const rpIdHash = (rpId: string): Hex => `0x${bytesToHex(sha256(utf8ToBytes(rpId)))}`
const RP_ID_HASH = rpIdHash("vault.mida.xyz")
const CHALLENGE: Hex = `0x${"ab".repeat(32)}`
const { qx, qy } = p256PublicKey(KEY)
const valid = assertionToWire(signVaultAssertion({ challenge: CHALLENGE, privateKey: KEY, rpId: "vault.mida.xyz", origin: "https://vault.mida.xyz" }))
const verify = (assertion: WebAuthnAssertionWire, challenge: Hex = CHALLENGE) => verifyVaultAssertion({ challenge, assertion, qx, qy, rpIdHash: RP_ID_HASH })

/** Re-signs a mutated assertion with the real key, so each rejection is caused by the mutated field alone. */
function resigned(authenticatorData: Uint8Array, clientDataJSON: string): WebAuthnAssertionWire {
  const message = concatBytes(authenticatorData, sha256(utf8ToBytes(clientDataJSON)))
  const signature = p256.sign(message, hexToBytes(KEY.slice(2)), { prehash: true, lowS: true })
  return {
    ...valid,
    authenticatorData: `0x${bytesToHex(authenticatorData)}`,
    clientDataJSON,
    r: `0x${bytesToHex(signature.slice(0, 32))}`,
    s: `0x${bytesToHex(signature.slice(32, 64))}`,
  }
}

const authData = (rpId: string, flags: number) => concatBytes(sha256(utf8ToBytes(rpId)), new Uint8Array([flags, 0, 0, 0, 0]))

describe("off-chain Vault assertion verification (§12.5 cancellation)", () => {
  it("accepts the Vault's own ox-produced assertion and a re-signed copy of it", () => {
    expect(verify(valid)).toBe(true)
    expect(verify(resigned(authData("vault.mida.xyz", 0x05), valid.clientDataJSON))).toBe(true)
  })

  it("rejects a different challenge or a different owner key", () => {
    expect(verify(valid, `0x${"ac".repeat(32)}`)).toBe(false)
    const other = p256PublicKey(OTHER_KEY)
    expect(verifyVaultAssertion({ challenge: CHALLENGE, assertion: valid, qx: other.qx, qy: other.qy, rpIdHash: RP_ID_HASH })).toBe(false)
  })

  it("rejects another RP ID, a missing UV flag and a missing UP flag even when correctly signed", () => {
    expect(verify(resigned(authData("evil.example", 0x05), valid.clientDataJSON))).toBe(false)
    expect(verify(resigned(authData("vault.mida.xyz", 0x01), valid.clientDataJSON))).toBe(false)
    expect(verify(resigned(authData("vault.mida.xyz", 0x04), valid.clientDataJSON))).toBe(false)
  })

  it("rejects a create-type ceremony, high-s and truncated authenticator data", () => {
    expect(verify(resigned(authData("vault.mida.xyz", 0x05), valid.clientDataJSON.replace("webauthn.get", "webauthn.set")))).toBe(false)
    expect(verify({ ...valid, s: `0x${(N - BigInt(valid.s)).toString(16).padStart(64, "0")}` })).toBe(false)
    expect(verify({ ...valid, authenticatorData: valid.authenticatorData.slice(0, 2 + 36 * 2) as Hex })).toBe(false)
  })

  it("does not check clientDataJSON.origin: a foreign origin with the Vault RP-ID hash still verifies (documented v0 limit)", () => {
    const foreign = valid.clientDataJSON.replace("https://vault.mida.xyz", "https://evil.example")
    expect(verify(resigned(authData("vault.mida.xyz", 0x05), foreign))).toBe(true)
  })
})
