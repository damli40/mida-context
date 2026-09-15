import fc from "fast-check"
import { sha256 } from "@noble/hashes/sha2.js"
import { utf8ToBytes } from "@noble/hashes/utils.js"
import { describe, expect, it } from "vitest"
import { isMidaError, namespaceId } from "@mida/protocol"
import {
  ISOLATION_DOMAINS,
  deriveEpochKeyPair,
  deriveNamespaceSecret,
  generateX25519KeyPair,
  hexOf,
  prfSalt,
  uint64be,
  x25519PublicKey,
  x25519SharedSecret,
} from "@mida/crypto"

const failsWith = (code: Parameters<typeof isMidaError>[1], fn: () => unknown) => {
  try {
    fn()
  } catch (error) {
    return isMidaError(error, code)
  }
  return false
}

const fakePrf = (fill: number) => new Uint8Array(32).fill(fill)
const career = namespaceId("goals.career")

const GOLDEN = {
  secret: "0x7bcd44384f94f98a5965ddec021c122212b41476bb5d9cd37efe446c6436307b",
  epoch1PrivateKey: "0xf5e549e7d4c9795b5d1bd798ba4acc22f96ad6037e011eea754a6dc9e9c58fc9",
  epoch1PublicKey: "0x547957f9bd11b33c378ad167350504e5becae07799e30b26d85601c83664fd0c",
  epoch2PublicKey: "0x1026462a273c38ccf967091089aff0deaf421f5f53e46437fabfa970240e7e4e",
}

describe("PRF isolation domains (§6.1)", () => {
  it("salts are SHA256 of the frozen domain strings", () => {
    expect(ISOLATION_DOMAINS).toEqual(["general", "financial", "relationships", "private"])
    for (const domain of ISOLATION_DOMAINS) {
      expect(prfSalt(domain)).toEqual(sha256(utf8ToBytes(`mida/context/prf/${domain}/v1`)))
    }
    expect(new Set(ISOLATION_DOMAINS.map((d) => hexOf(prfSalt(d)))).size).toBe(4)
  })

  it("different domain PRF outputs derive unrelated namespace secrets", () => {
    const general = deriveNamespaceSecret(fakePrf(0x01), namespaceId("financial.preferences"))
    const financial = deriveNamespaceSecret(fakePrf(0x02), namespaceId("financial.preferences"))
    expect(hexOf(general)).not.toBe(hexOf(financial))
  })
})

describe("namespace secrets and epoch keypairs (§6.2, §7.1)", () => {
  it("matches the frozen golden vector (PRF output = 32 bytes of 0x42, goals.career)", () => {
    const secret = deriveNamespaceSecret(fakePrf(0x42), career)
    const epoch1 = deriveEpochKeyPair(secret, 1n)
    expect(hexOf(secret)).toBe(GOLDEN.secret)
    expect(hexOf(epoch1.privateKey)).toBe(GOLDEN.epoch1PrivateKey)
    expect(hexOf(epoch1.publicKey)).toBe(GOLDEN.epoch1PublicKey)
    expect(hexOf(deriveEpochKeyPair(secret, 2n).publicKey)).toBe(GOLDEN.epoch2PublicKey)
  })

  it("is deterministic across fresh derivations (recovery seam)", () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 32, maxLength: 32 }), fc.bigInt({ min: 1n, max: 1000n }), (prf, epoch) => {
        fc.pre(prf.some((b) => b !== 0))
        const first = deriveEpochKeyPair(deriveNamespaceSecret(prf, career), epoch)
        const second = deriveEpochKeyPair(deriveNamespaceSecret(prf.slice(), career), epoch)
        expect(hexOf(second.publicKey)).toBe(hexOf(first.publicKey))
      }),
      { numRuns: 50 },
    )
  })

  it("separates namespaces and epochs", () => {
    const prf = fakePrf(0x42)
    const careerSecret = deriveNamespaceSecret(prf, career)
    const learningSecret = deriveNamespaceSecret(prf, namespaceId("goals.learning"))
    expect(hexOf(careerSecret)).not.toBe(hexOf(learningSecret))
    expect(hexOf(deriveEpochKeyPair(careerSecret, 1n).publicKey)).not.toBe(hexOf(deriveEpochKeyPair(careerSecret, 2n).publicKey))
  })

  it("encodes the epoch salt as 8-byte big-endian uint64", () => {
    expect(uint64be(1n)).toEqual(new Uint8Array([0, 0, 0, 0, 0, 0, 0, 1]))
    expect(uint64be(258n)).toEqual(new Uint8Array([0, 0, 0, 0, 0, 0, 1, 2]))
    expect(failsWith("INVALID_WIRE", () => uint64be(-1n))).toBe(true)
  })

  it("rejects zero inputs and epoch 0", () => {
    expect(failsWith("ZERO_KEY", () => deriveNamespaceSecret(new Uint8Array(32), career))).toBe(true)
    expect(failsWith("ZERO_KEY", () => deriveNamespaceSecret(new Uint8Array(16).fill(1), career))).toBe(true)
    expect(failsWith("ZERO_KEY", () => deriveEpochKeyPair(new Uint8Array(32), 1n))).toBe(true)
    expect(failsWith("INVALID_WIRE", () => deriveEpochKeyPair(fakePrf(9), 0n))).toBe(true)
  })
})

describe("X25519 zero checks (§7.1)", () => {
  it("agrees on a shared secret between two parties", () => {
    const a = generateX25519KeyPair()
    const b = generateX25519KeyPair()
    expect(hexOf(x25519SharedSecret(a.privateKey, b.publicKey))).toBe(hexOf(x25519SharedSecret(b.privateKey, a.publicKey)))
    expect(hexOf(x25519PublicKey(a.privateKey))).toBe(hexOf(a.publicKey))
  })

  it("rejects an all-zero public key before calling the curve", () => {
    expect(failsWith("ZERO_KEY", () => x25519SharedSecret(generateX25519KeyPair().privateKey, new Uint8Array(32)))).toBe(true)
  })

  it("maps a low-order public key (all-zero shared secret) to ZERO_KEY", () => {
    const lowOrder = new Uint8Array(32)
    lowOrder[0] = 1
    expect(failsWith("ZERO_KEY", () => x25519SharedSecret(generateX25519KeyPair().privateKey, lowOrder))).toBe(true)
  })
})
