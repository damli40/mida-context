import { describe, expect, it } from "vitest"
import { encodeAbiParameters, getAddress } from "viem"
import type { Address, Hex } from "viem"
import { isMidaError, namespaceId } from "@mida/protocol"
import {
  deriveEpochKeyPair,
  deriveNamespaceSecret,
  generateX25519KeyPair,
  hexOf,
  readerEpochWrapAad,
  unwrapDekFromEpoch,
  unwrapEpochPrivateKey,
  wrapDekToEpoch,
  wrapEpochPrivateKeyToAgent,
} from "@mida/crypto"
import type { ObjectBinding, ReaderBinding } from "@mida/crypto"

const failsWith = (code: Parameters<typeof isMidaError>[1], fn: () => unknown) => {
  try {
    fn()
  } catch (error) {
    return isMidaError(error, code)
  }
  return false
}

const career = namespaceId("goals.career")
const secret = deriveNamespaceSecret(new Uint8Array(32).fill(0x42), career)
const epoch1 = deriveEpochKeyPair(secret, 1n)
const epoch2 = deriveEpochKeyPair(secret, 2n)
const dek = new Uint8Array(32).fill(0x07)

const objectBinding: ObjectBinding = {
  chainId: 31337n,
  contextRegistry: "0x3333333333333333333333333333333333333333",
  contextId: `0x${"cc".repeat(32)}`,
  namespaceId: career,
  readEpoch: 1n,
}

const agentA = generateX25519KeyPair()
const agentB = generateX25519KeyPair()
const readerBinding: ReaderBinding = {
  chainId: 31337n,
  capabilityRegistry: "0x1111111111111111111111111111111111111111",
  owner: "0x2222222222222222222222222222222222222222",
  namespaceId: career,
  readEpoch: 1n,
  agentId: `0x${"aa".repeat(32)}`,
  agentKeyVersion: 1,
}

describe("epoch DEK wrap (§8.3)", () => {
  it("round-trips with the matching epoch private key", () => {
    const wrap = wrapDekToEpoch({ dek, epochPublicKey: epoch1.publicKey, binding: objectBinding })
    expect(wrap.readEpoch).toBe("1")
    expect(wrap.wrappedDek.length).toBe(2 + 48 * 2)
    expect(unwrapDekFromEpoch({ wrap, epochPrivateKey: epoch1.privateKey, binding: objectBinding })).toEqual(dek)
  })

  it("cannot be opened with another epoch's private key", () => {
    const wrap = wrapDekToEpoch({ dek, epochPublicKey: epoch1.publicKey, binding: objectBinding })
    expect(failsWith("DECRYPT_FAILED", () => unwrapDekFromEpoch({ wrap, epochPrivateKey: epoch2.privateKey, binding: objectBinding }))).toBe(true)
  })

  it("cannot be opened with a different namespace secret", () => {
    const wrap = wrapDekToEpoch({ dek, epochPublicKey: epoch1.publicKey, binding: objectBinding })
    const stranger = deriveEpochKeyPair(deriveNamespaceSecret(new Uint8Array(32).fill(0x43), career), 1n)
    expect(failsWith("DECRYPT_FAILED", () => unwrapDekFromEpoch({ wrap, epochPrivateKey: stranger.privateKey, binding: objectBinding }))).toBe(true)
  })

  it("cannot be transplanted to another object, even with rewritten metadata", () => {
    const wrap = wrapDekToEpoch({ dek, epochPublicKey: epoch1.publicKey, binding: objectBinding })
    const otherObject: ObjectBinding = { ...objectBinding, contextId: `0x${"dd".repeat(32)}` }
    expect(failsWith("DECRYPT_FAILED", () => unwrapDekFromEpoch({ wrap, epochPrivateKey: epoch1.privateKey, binding: otherObject }))).toBe(true)
    const rewritten = { ...wrap, contextId: otherObject.contextId }
    expect(failsWith("DECRYPT_FAILED", () => unwrapDekFromEpoch({ wrap: rewritten, epochPrivateKey: epoch1.privateKey, binding: otherObject }))).toBe(true)
  })

  it("rejects malformed wrap fields", () => {
    const wrap = wrapDekToEpoch({ dek, epochPublicKey: epoch1.publicKey, binding: objectBinding })
    expect(failsWith("INVALID_WIRE", () => unwrapDekFromEpoch({ wrap: { ...wrap, nonce: "0x00" as Hex }, epochPrivateKey: epoch1.privateKey, binding: objectBinding }))).toBe(true)
    expect(failsWith("ZERO_KEY", () => unwrapDekFromEpoch({ wrap: { ...wrap, ephemeralPublicKey: `0x${"00".repeat(32)}` }, epochPrivateKey: epoch1.privateKey, binding: objectBinding }))).toBe(true)
  })
})

describe("reader epoch wrap (§8.4)", () => {
  it("AAD is abi.encode(string, uint256, address, address, bytes32, uint64, bytes32, uint32, string)", () => {
    const expected = encodeAbiParameters(
      [{ type: "string" }, { type: "uint256" }, { type: "address" }, { type: "address" }, { type: "bytes32" }, { type: "uint64" }, { type: "bytes32" }, { type: "uint32" }, { type: "string" }],
      ["MIDA_READER_EPOCH_WRAP_V1", 31337n, readerBinding.capabilityRegistry, readerBinding.owner, career, 1n, readerBinding.agentId, 1, "mida-crypto-v1"],
    )
    expect(hexOf(readerEpochWrapAad(readerBinding))).toBe(expected)
  })

  it("the registered agent key and version unwrap the epoch private key", () => {
    const wrap = wrapEpochPrivateKeyToAgent({ epochPrivateKey: epoch1.privateKey, agentEncryptionPublicKey: agentA.publicKey, binding: readerBinding, createdAt: 1_757_000_000n })
    expect(wrap.createdAt).toBe("1757000000")
    const recovered = unwrapEpochPrivateKey({ wrap, agentEncryptionPrivateKey: agentA.privateKey, binding: readerBinding })
    expect(hexOf(recovered)).toBe(hexOf(epoch1.privateKey))
  })

  it("a different agent's key cannot unwrap it", () => {
    const wrap = wrapEpochPrivateKeyToAgent({ epochPrivateKey: epoch1.privateKey, agentEncryptionPublicKey: agentA.publicKey, binding: readerBinding, createdAt: 1n })
    expect(failsWith("DECRYPT_FAILED", () => unwrapEpochPrivateKey({ wrap, agentEncryptionPrivateKey: agentB.privateKey, binding: readerBinding }))).toBe(true)
  })

  it("cannot be transplanted to another agent id", () => {
    const wrap = wrapEpochPrivateKeyToAgent({ epochPrivateKey: epoch1.privateKey, agentEncryptionPublicKey: agentA.publicKey, binding: readerBinding, createdAt: 1n })
    const otherAgent: ReaderBinding = { ...readerBinding, agentId: `0x${"bb".repeat(32)}` }
    expect(failsWith("DECRYPT_FAILED", () => unwrapEpochPrivateKey({ wrap, agentEncryptionPrivateKey: agentA.privateKey, binding: otherAgent }))).toBe(true)
    expect(failsWith("DECRYPT_FAILED", () => unwrapEpochPrivateKey({ wrap: { ...wrap, agentId: otherAgent.agentId }, agentEncryptionPrivateKey: agentA.privateKey, binding: otherAgent }))).toBe(true)
  })

  it("cannot be transplanted to another key version", () => {
    const wrap = wrapEpochPrivateKeyToAgent({ epochPrivateKey: epoch1.privateKey, agentEncryptionPublicKey: agentA.publicKey, binding: readerBinding, createdAt: 1n })
    const rotated: ReaderBinding = { ...readerBinding, agentKeyVersion: 2 }
    expect(failsWith("WRAP_KEY_VERSION_MISMATCH", () => unwrapEpochPrivateKey({ wrap, agentEncryptionPrivateKey: agentA.privateKey, binding: rotated }))).toBe(true)
    expect(failsWith("DECRYPT_FAILED", () => unwrapEpochPrivateKey({ wrap: { ...wrap, agentKeyVersion: 2 }, agentEncryptionPrivateKey: agentA.privateKey, binding: rotated }))).toBe(true)
  })

  it("cannot be replayed for another owner, namespace, epoch or registry", () => {
    const wrap = wrapEpochPrivateKeyToAgent({ epochPrivateKey: epoch1.privateKey, agentEncryptionPublicKey: agentA.publicKey, binding: readerBinding, createdAt: 1n })
    const variants: ReaderBinding[] = [
      { ...readerBinding, owner: "0x5555555555555555555555555555555555555555" },
      { ...readerBinding, namespaceId: namespaceId("goals.learning") },
      { ...readerBinding, readEpoch: 2n },
      { ...readerBinding, capabilityRegistry: "0x6666666666666666666666666666666666666666" },
    ]
    for (const variant of variants) {
      expect(failsWith("DECRYPT_FAILED", () => unwrapEpochPrivateKey({ wrap, agentEncryptionPrivateKey: agentA.privateKey, binding: variant }))).toBe(true)
    }
  })
})

describe("wrap input validation", () => {
  it("rejects keys that are not 32 non-zero bytes", () => {
    expect(failsWith("ZERO_KEY", () => wrapDekToEpoch({ dek: new Uint8Array(16), epochPublicKey: epoch1.publicKey, binding: objectBinding }))).toBe(true)
    expect(failsWith("ZERO_KEY", () => wrapDekToEpoch({ dek: new Uint8Array(32), epochPublicKey: epoch1.publicKey, binding: objectBinding }))).toBe(true)
    expect(failsWith("ZERO_KEY", () => wrapEpochPrivateKeyToAgent({ epochPrivateKey: new Uint8Array(64), agentEncryptionPublicKey: agentA.publicKey, binding: readerBinding, createdAt: 1n }))).toBe(true)
  })

  it("rejects out-of-range binding numbers with INVALID_WIRE, not a raw encoder error", () => {
    for (const readEpoch of [2n ** 64n, -1n]) {
      expect(failsWith("INVALID_WIRE", () => wrapDekToEpoch({ dek, epochPublicKey: epoch1.publicKey, binding: { ...objectBinding, readEpoch } }))).toBe(true)
      expect(failsWith("INVALID_WIRE", () => readerEpochWrapAad({ ...readerBinding, readEpoch }))).toBe(true)
    }
    expect(failsWith("INVALID_WIRE", () => wrapDekToEpoch({ dek, epochPublicKey: epoch1.publicKey, binding: { ...objectBinding, chainId: -1n } }))).toBe(true)
    expect(failsWith("INVALID_WIRE", () => readerEpochWrapAad({ ...readerBinding, chainId: -1n }))).toBe(true)
    for (const agentKeyVersion of [2 ** 32, -1, 1.5, Number.NaN]) {
      expect(failsWith("INVALID_WIRE", () => readerEpochWrapAad({ ...readerBinding, agentKeyVersion }))).toBe(true)
    }
  })

  it("rejects malformed addresses with INVALID_WIRE", () => {
    expect(failsWith("INVALID_WIRE", () => readerEpochWrapAad({ ...readerBinding, owner: "0x2222" as Address }))).toBe(true)
    expect(failsWith("INVALID_WIRE", () => readerEpochWrapAad({ ...readerBinding, capabilityRegistry: "0xgggggggggggggggggggggggggggggggggggggggg" as Address }))).toBe(true)
  })

  it("lowercases a checksummed owner on the wire and still unwraps", () => {
    const mixedOwner = getAddress("0xabcdefabcdefabcdefabcdefabcdefabcdefabcd")
    const mixed: ReaderBinding = { ...readerBinding, owner: mixedOwner }
    const wrap = wrapEpochPrivateKeyToAgent({ epochPrivateKey: epoch1.privateKey, agentEncryptionPublicKey: agentA.publicKey, binding: mixed, createdAt: 1n })
    expect(wrap.owner).not.toBe(mixedOwner)
    expect(wrap.owner).toBe(mixedOwner.toLowerCase())
    const recovered = unwrapEpochPrivateKey({ wrap, agentEncryptionPrivateKey: agentA.privateKey, binding: mixed })
    expect(hexOf(recovered)).toBe(hexOf(epoch1.privateKey))
  })
})
