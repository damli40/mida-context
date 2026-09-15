import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { encodeAbiParameters, toHex } from "viem"
import type { Hex } from "viem"
import { isMidaError, namespaceId } from "@mida/protocol"
import type { ContextPayload } from "@mida/protocol"
import { decodePayload, decryptPayload, encodePayload, encryptPayload, epochDekWrapAad, hexOf, payloadAad } from "@mida/crypto"
import type { ObjectBinding } from "@mida/crypto"

const failsWith = (code: Parameters<typeof isMidaError>[1], fn: () => unknown) => {
  try {
    fn()
  } catch (error) {
    return isMidaError(error, code)
  }
  return false
}

const uint = (value: bigint | number) => BigInt(value).toString(16).padStart(64, "0")
const word = (hex: string) => hex.slice(2).padStart(64, "0")
const stringTail = (value: string) => {
  const hex = Buffer.from(value, "utf8").toString("hex")
  return uint(hex.length / 2) + hex.padEnd(Math.ceil(hex.length / 64) * 64, "0")
}

const binding: ObjectBinding = {
  chainId: 31337n,
  contextRegistry: "0x3333333333333333333333333333333333333333",
  contextId: `0x${"cc".repeat(32)}`,
  namespaceId: namespaceId("goals.career"),
  readEpoch: 1n,
}

const payload: ContextPayload = {
  v: 1,
  value: "Prioritize systems engineering",
  kind: "GOAL",
  provenance: { source: "USER_ASSERTED" },
}

describe("payload AAD layout (§8.2, plan decision 2)", () => {
  it("is abi.encode(string, uint256, address, bytes32, bytes32, uint64, string)", () => {
    const tag = stringTail("MIDA_CONTEXT_PAYLOAD_V1")
    const head = [
      uint(7 * 32),
      uint(binding.chainId),
      word(binding.contextRegistry),
      word(binding.contextId),
      word(binding.namespaceId),
      uint(binding.readEpoch),
      uint(7 * 32 + tag.length / 2),
    ]
    const expected = `0x${head.join("")}${tag}${stringTail("mida-crypto-v1")}`
    expect(hexOf(payloadAad(binding))).toBe(expected)
  })

  it("payload and epoch-DEK-wrap AADs differ only by tag", () => {
    const types = [{ type: "string" }, { type: "uint256" }, { type: "address" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint64" }, { type: "string" }] as const
    const values = (tag: string) => [tag, binding.chainId, binding.contextRegistry, binding.contextId, binding.namespaceId, binding.readEpoch, "mida-crypto-v1"] as const
    expect(hexOf(epochDekWrapAad(binding))).toBe(encodeAbiParameters(types, values("MIDA_EPOCH_DEK_WRAP_V1")))
    expect(hexOf(payloadAad(binding))).not.toBe(hexOf(epochDekWrapAad(binding)))
  })
})

describe("payload encoding", () => {
  it("is canonical JSON and round-trips", () => {
    const reordered = { provenance: { source: "USER_ASSERTED" }, kind: "GOAL", value: payload.value, v: 1 } as ContextPayload
    expect(toHex(encodePayload(reordered))).toBe(toHex(encodePayload(payload)))
    expect(decodePayload(encodePayload(payload))).toEqual(payload)
  })

  it("caps the plaintext at 65,536 bytes", () => {
    const base = encodePayload({ ...payload, value: "" }).length
    expect(encodePayload({ ...payload, value: "x".repeat(65_536 - base) }).length).toBe(65_536)
    expect(failsWith("PAYLOAD_TOO_LARGE", () => encodePayload({ ...payload, value: "x".repeat(65_537 - base) }))).toBe(true)
  })

  it("rejects non-canonical, non-JSON and non-UTF-8 plaintext", () => {
    expect(failsWith("INVALID_WIRE", () => decodePayload(new TextEncoder().encode('{"v":1, "kind":"GOAL"}')))).toBe(true)
    expect(failsWith("INVALID_WIRE", () => decodePayload(new TextEncoder().encode("not json")))).toBe(true)
    expect(failsWith("INVALID_WIRE", () => decodePayload(new Uint8Array([0xff, 0xfe])))).toBe(true)
  })
})

describe("payload encryption (§8.2)", () => {
  it("decrypts with the same DEK and binding", () => {
    const sealed = encryptPayload(payload, binding)
    expect(sealed.dek).toHaveLength(32)
    expect(sealed.nonce).toHaveLength(24)
    expect(decryptPayload(sealed, binding)).toEqual(payload)
  })

  it("uses a fresh DEK and nonce every time", () => {
    const first = encryptPayload(payload, binding)
    const second = encryptPayload(payload, binding)
    expect(hexOf(first.dek)).not.toBe(hexOf(second.dek))
    expect(hexOf(first.nonce)).not.toBe(hexOf(second.nonce))
  })

  it("fails closed when any bound field changes", () => {
    const sealed = encryptPayload(payload, binding)
    const other: Hex = `0x${"dd".repeat(32)}`
    const variants: ObjectBinding[] = [
      { ...binding, chainId: 10143n },
      { ...binding, contextRegistry: "0x4444444444444444444444444444444444444444" },
      { ...binding, contextId: other },
      { ...binding, namespaceId: namespaceId("goals.learning") },
      { ...binding, readEpoch: 2n },
    ]
    for (const variant of variants) {
      expect(failsWith("DECRYPT_FAILED", () => decryptPayload(sealed, variant))).toBe(true)
    }
  })

  it("detects any single-bit ciphertext mutation", () => {
    const sealed = encryptPayload(payload, binding)
    fc.assert(
      fc.property(fc.nat({ max: sealed.ciphertext.length * 8 - 1 }), (bit) => {
        const mutated = sealed.ciphertext.slice()
        mutated[bit >> 3]! ^= 1 << (bit & 7)
        expect(failsWith("DECRYPT_FAILED", () => decryptPayload({ ...sealed, ciphertext: mutated }, binding))).toBe(true)
      }),
      { numRuns: 100 },
    )
  })
})
