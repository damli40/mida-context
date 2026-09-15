import { describe, expect, it } from "vitest"
import { keccak256 } from "viem"
import { sha256 } from "@noble/hashes/sha2.js"
import { canonicalBytes, isMidaError, namespaceId } from "@mida/protocol"
import type { ContextPayload } from "@mida/protocol"
import {
  ciphertextHash,
  deriveEpochKeyPair,
  deriveNamespaceSecret,
  generateX25519KeyPair,
  hexOf,
  manifestHash,
  openContextObject,
  sealContextObject,
  unwrapEpochPrivateKey,
  wrapEpochPrivateKeyToAgent,
} from "@mida/crypto"
import type { ObjectBinding } from "@mida/crypto"

const failsWith = (code: Parameters<typeof isMidaError>[1], fn: () => unknown) => {
  try {
    fn()
  } catch (error) {
    return isMidaError(error, code)
  }
  return false
}

const career = namespaceId("goals.career")
const generalPrf = new Uint8Array(32).fill(0x42)
const epoch1 = deriveEpochKeyPair(deriveNamespaceSecret(generalPrf, career), 1n)
const epoch2 = deriveEpochKeyPair(deriveNamespaceSecret(generalPrf, career), 2n)
const payload: ContextPayload = { v: 1, value: "Prioritize systems engineering", kind: "GOAL", provenance: { source: "USER_ASSERTED" } }
const binding: ObjectBinding = {
  chainId: 31337n,
  contextRegistry: "0x3333333333333333333333333333333333333333",
  contextId: `0x${"cc".repeat(32)}`,
  namespaceId: career,
  readEpoch: 1n,
}

describe("object manifest commitments (§9.1)", () => {
  it("commits ciphertext by SHA-256 and manifest by keccak256 of canonical JSON", () => {
    const sealed = sealContextObject({ payload, binding, epochPublicKey: epoch1.publicKey })
    expect(sealed.manifest.ciphertextHash).toBe(hexOf(sha256(sealed.ciphertext)))
    expect(sealed.ciphertextCommitment).toBe(ciphertextHash(sealed.ciphertext))
    expect(sealed.manifestHash).toBe(keccak256(canonicalBytes(sealed.manifest)))
    expect(sealed.manifest).toMatchObject({ v: 1, contextId: binding.contextId, cryptoVersion: "mida-crypto-v1", readEpoch: "1", ciphertextSize: sealed.ciphertext.length })
    expect(sealed.manifest.epochDekWrap.contextId).toBe(binding.contextId)
    expect(Object.keys(sealed.manifest)).not.toContain("storage")
  })
})

describe("CREATE vs READ (§7.1)", () => {
  it("a writer with only the epoch public key seals; a reader with the private key opens", () => {
    const sealed = sealContextObject({ payload, binding, epochPublicKey: epoch1.publicKey })
    expect(openContextObject({ ...sealed, expectedManifestHash: sealed.manifestHash, epochPrivateKey: epoch1.privateKey, binding })).toEqual(payload)
  })

  it("a reader holding only the epoch-1 key cannot open an epoch-2 object (forward revocation)", () => {
    const epoch2Binding = { ...binding, contextId: `0x${"ee".repeat(32)}`, readEpoch: 2n } as ObjectBinding
    const sealed = sealContextObject({ payload, binding: epoch2Binding, epochPublicKey: epoch2.publicKey })
    expect(failsWith("DECRYPT_FAILED", () => openContextObject({ ...sealed, expectedManifestHash: sealed.manifestHash, epochPrivateKey: epoch1.privateKey, binding: epoch2Binding }))).toBe(true)
  })

  it("a reader wrap delivers the epoch key to the agent end to end", () => {
    const agent = generateX25519KeyPair()
    const readerBinding = { chainId: 31337n, capabilityRegistry: "0x1111111111111111111111111111111111111111", owner: "0x2222222222222222222222222222222222222222", namespaceId: career, readEpoch: 1n, agentId: `0x${"aa".repeat(32)}`, agentKeyVersion: 1 } as const
    const wrap = wrapEpochPrivateKeyToAgent({ epochPrivateKey: epoch1.privateKey, agentEncryptionPublicKey: agent.publicKey, binding: readerBinding, createdAt: 1n })
    const epochKey = unwrapEpochPrivateKey({ wrap, agentEncryptionPrivateKey: agent.privateKey, binding: readerBinding })
    const sealed = sealContextObject({ payload, binding, epochPublicKey: epoch1.publicKey })
    expect(openContextObject({ ...sealed, expectedManifestHash: sealed.manifestHash, epochPrivateKey: epochKey, binding })).toEqual(payload)
  })
})

describe("recovery seam and domain isolation (§15)", () => {
  it("the same fake domain output in a fresh derivation opens the object", () => {
    const sealed = sealContextObject({ payload, binding, epochPublicKey: epoch1.publicKey })
    const recovered = deriveEpochKeyPair(deriveNamespaceSecret(new Uint8Array(32).fill(0x42), career), 1n)
    expect(openContextObject({ ...sealed, expectedManifestHash: sealed.manifestHash, epochPrivateKey: recovered.privateKey, binding })).toEqual(payload)
  })

  it("a different domain output (general used for financial) fails to decrypt", () => {
    const financial = namespaceId("financial.preferences")
    const financialBinding = { ...binding, namespaceId: financial } as ObjectBinding
    const financialEpoch = deriveEpochKeyPair(deriveNamespaceSecret(new Uint8Array(32).fill(0x77), financial), 1n)
    const sealed = sealContextObject({ payload, binding: financialBinding, epochPublicKey: financialEpoch.publicKey })
    const wrongDomain = deriveEpochKeyPair(deriveNamespaceSecret(generalPrf, financial), 1n)
    expect(failsWith("DECRYPT_FAILED", () => openContextObject({ ...sealed, expectedManifestHash: sealed.manifestHash, epochPrivateKey: wrongDomain.privateKey, binding: financialBinding }))).toBe(true)
  })
})

describe("mutation is detected before decryption (§15 Crypto)", () => {
  const sealed = sealContextObject({ payload, binding, epochPublicKey: epoch1.publicKey })

  it("mutated manifest fails its on-chain commitment", () => {
    const mutated = { ...sealed.manifest, payloadNonce: `0x${"00".repeat(24)}` as const }
    expect(failsWith("MANIFEST_MISMATCH", () => openContextObject({ manifest: mutated, ciphertext: sealed.ciphertext, expectedManifestHash: sealed.manifestHash, epochPrivateKey: epoch1.privateKey, binding }))).toBe(true)
  })

  it("mutated ciphertext fails the content hash", () => {
    const ciphertext = sealed.ciphertext.slice()
    ciphertext[0]! ^= 1
    expect(failsWith("CONTENT_HASH_MISMATCH", () => openContextObject({ manifest: sealed.manifest, ciphertext, expectedManifestHash: sealed.manifestHash, epochPrivateKey: epoch1.privateKey, binding }))).toBe(true)
  })

  it("manifest committed for another object cannot be used under this binding", () => {
    const other = { ...binding, contextId: `0x${"dd".repeat(32)}` } as ObjectBinding
    expect(failsWith("MANIFEST_MISMATCH", () => openContextObject({ ...sealed, expectedManifestHash: sealed.manifestHash, epochPrivateKey: epoch1.privateKey, binding: other }))).toBe(true)
  })

  it("recomputing the hash over a mutated manifest still fails AEAD", () => {
    const mutated = { ...sealed.manifest, payloadNonce: `0x${"00".repeat(24)}` as const }
    expect(failsWith("DECRYPT_FAILED", () => openContextObject({ manifest: mutated, ciphertext: sealed.ciphertext, expectedManifestHash: manifestHash(mutated), epochPrivateKey: epoch1.privateKey, binding }))).toBe(true)
  })
})
