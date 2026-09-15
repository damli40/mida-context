import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { keccak256, zeroHash } from "viem"
import type { Hex } from "viem"
import {
  NAMESPACE_TREE_VERSION_HASH,
  OWNER_AUTHOR_ID,
  POLICY_VERSION_HASH,
  agentId,
  assertCanonicalScopes,
  canonicalReferences,
  canonicalizeOrigin,
  capabilityId,
  contextId,
  evidenceCommitment,
  grantDigest,
  hashString,
  isMidaError,
  namespaceId,
  originHash,
  scopesHash,
  sortScopes,
} from "@mida/protocol"

// Independent ABI builders: one 32-byte word per static value, then the string tail.
const uint = (value: bigint | number) => BigInt(value).toString(16).padStart(64, "0")
const word = (hex: string) => hex.slice(2).padStart(64, "0")
const stringTail = (value: string) => {
  const hex = Buffer.from(value, "utf8").toString("hex")
  return uint(hex.length / 2) + hex.padEnd(Math.ceil(hex.length / 64) * 64, "0")
}
const leadingString = (tag: string, words: string[]): Hex =>
  `0x${uint((words.length + 1) * 32)}${words.join("")}${stringTail(tag)}`

const REGISTRY = "0x1111111111111111111111111111111111111111"
const OWNER = "0x2222222222222222222222222222222222222222"
const A32: Hex = `0x${"aa".repeat(32)}`
const B32: Hex = `0x${"bb".repeat(32)}`
const C32: Hex = `0x${"cc".repeat(32)}`

const failsWith = (code: Parameters<typeof isMidaError>[1], fn: () => unknown) => {
  try {
    fn()
  } catch (error) {
    return isMidaError(error, code)
  }
  return false
}

describe("object and agent identifiers (§4.3, §8.1)", () => {
  it("owner author id is bytes32(0)", () => {
    expect(OWNER_AUTHOR_ID).toBe(zeroHash)
  })

  it("contextId uses (string, uint256, address, address, bytes32, bytes32, bytes32)", () => {
    const nsId = namespaceId("goals.career")
    const expected = keccak256(
      leadingString("MIDA_CONTEXT_OBJECT_V1", [uint(31337), word(REGISTRY), word(OWNER), word(A32), word(nsId), word(B32)]),
    )
    expect(
      contextId({ chainId: 31337n, contextRegistry: REGISTRY, owner: OWNER, authorId: A32, namespaceId: nsId, objectNonce: B32 }),
    ).toBe(expected)
  })

  it("contextId changes when any nonce byte changes", () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 32, maxLength: 32 }), (bytes) => {
        const nonce = `0x${Buffer.from(bytes).toString("hex")}` as Hex
        fc.pre(nonce !== B32)
        const base = { chainId: 31337n, contextRegistry: REGISTRY, owner: OWNER, authorId: zeroHash, namespaceId: A32 } as const
        expect(contextId({ ...base, objectNonce: nonce })).not.toBe(contextId({ ...base, objectNonce: B32 }))
      }),
    )
  })

  it("agentId uses (string, uint256, address, address, bytes32)", () => {
    const expected = keccak256(leadingString("MIDA_AGENT_V1", [uint(10143), word(REGISTRY), word(OWNER), word(C32)]))
    expect(agentId({ chainId: 10143n, capabilityRegistry: REGISTRY, operator: OWNER, agentSalt: C32 })).toBe(expected)
  })
})

describe("scopes, capabilities and grant digest (§10.4)", () => {
  const career = namespaceId("goals.career")
  const financial = namespaceId("financial")
  const scopes = sortScopes([
    { namespaceId: career, permissions: 1, provenancePolicy: 0 },
    { namespaceId: financial, permissions: 3, provenancePolicy: 1 },
  ])

  it("sorts by namespaceId and validates canonical scope lists", () => {
    expect(scopes[0]!.namespaceId < scopes[1]!.namespaceId).toBe(true)
    expect(() => assertCanonicalScopes(scopes)).not.toThrow()
    expect(failsWith("INVALID_WIRE", () => assertCanonicalScopes([]))).toBe(true)
    expect(failsWith("INVALID_WIRE", () => assertCanonicalScopes([...scopes].reverse()))).toBe(true)
    expect(failsWith("INVALID_WIRE", () => assertCanonicalScopes([scopes[0]!, scopes[0]!]))).toBe(true)
    expect(failsWith("INVALID_NAMESPACE", () => assertCanonicalScopes([{ namespaceId: A32, permissions: 1, provenancePolicy: 0 }]))).toBe(true)
    expect(failsWith("INVALID_WIRE", () => assertCanonicalScopes([{ namespaceId: career, permissions: 0, provenancePolicy: 0 }]))).toBe(true)
    expect(failsWith("INVALID_WIRE", () => assertCanonicalScopes([{ namespaceId: career, permissions: 16, provenancePolicy: 0 }]))).toBe(true)
    expect(failsWith("INVALID_WIRE", () => assertCanonicalScopes([{ namespaceId: career, permissions: 1, provenancePolicy: 8 }]))).toBe(true)
    expect(failsWith("INVALID_WIRE", () => assertCanonicalScopes([{ namespaceId: career, permissions: 2 ** 32 + 1, provenancePolicy: 0 }]))).toBe(true)
    expect(failsWith("INVALID_WIRE", () => assertCanonicalScopes([{ namespaceId: career, permissions: 1, provenancePolicy: 2 ** 32 }]))).toBe(true)
  })

  it("scopesHash encodes a dynamic array of (bytes32, uint8, uint8)", () => {
    const body = scopes.map((s) => word(s.namespaceId) + uint(s.permissions) + uint(s.provenancePolicy)).join("")
    expect(scopesHash(scopes)).toBe(keccak256(`0x${uint(32)}${uint(scopes.length)}${body}`))
  })

  it("capabilityId uses (string, address, bytes32, uint256, uint256, bytes32, uint8, uint8, uint64)", () => {
    const expected = keccak256(
      leadingString("MIDA_CAPABILITY_V1", [word(OWNER), word(A32), uint(3), uint(1), word(career), uint(1), uint(0), uint(86_400)]),
    )
    expect(
      capabilityId({ owner: OWNER, agentId: A32, grantNonce: 3n, index: 1n, namespaceId: career, permissions: 1, provenancePolicy: 0, expiresAt: 86_400n }),
    ).toBe(expected)
  })

  it("grantDigest binds every §10.4 field in order", () => {
    const expected = keccak256(
      leadingString("MIDA_GRANT_V1", [
        uint(31337), word(REGISTRY), word(OWNER), word(A32), word(B32), word(C32), uint(2),
        word(POLICY_VERSION_HASH), word(NAMESPACE_TREE_VERSION_HASH), word(scopesHash(scopes)),
        uint(7_000), uint(9),
      ]),
    )
    expect(
      grantDigest({
        chainId: 31337n, capabilityRegistry: REGISTRY, owner: OWNER, agentId: A32, requestHash: B32,
        manifestHash: C32, manifestVersion: 2n, finalScopes: scopes, expiresAt: 7_000n, grantNonce: 9n,
      }),
    ).toBe(expected)
  })

  it("version hashes are keccak256 of the version strings", () => {
    expect(POLICY_VERSION_HASH).toBe(hashString("mida-grant-policy-v1"))
    expect(NAMESPACE_TREE_VERSION_HASH).toBe(hashString("mida-namespace-tree-v1"))
  })
})

describe("evidence commitments (§11.8)", () => {
  it("sorts by (relation code, record id) and removes duplicate pairs", () => {
    const refs = canonicalReferences([
      { relation: "confirmed_from", recordId: A32 },
      { relation: "supports", recordId: C32 },
      { relation: "supports", recordId: B32 },
      { relation: "supports", recordId: C32 },
    ])
    expect(refs).toEqual([
      { relationCode: 1, recordId: B32 },
      { relationCode: 1, recordId: C32 },
      { relationCode: 3, recordId: A32 },
    ])
  })

  it("encodes (string, (uint8, bytes32)[]) and binds the relation", () => {
    const tag = stringTail("MIDA_EVIDENCE_V1")
    const arrayOffset = 0x40 + tag.length / 2
    const expected = keccak256(`0x${uint(0x40)}${uint(arrayOffset)}${tag}${uint(1)}${uint(2)}${word(A32)}`)
    expect(evidenceCommitment([{ relation: "derived_from", recordId: A32 }])).toBe(expected)
    expect(evidenceCommitment([{ relation: "supports", recordId: A32 }])).not.toBe(expected)
  })
})

describe("callback origins (§4.3)", () => {
  it("canonicalizes to a lowercase origin without default port", () => {
    expect(canonicalizeOrigin("https://Vault.Mida.XYZ")).toBe("https://vault.mida.xyz")
    expect(canonicalizeOrigin("https://vault.mida.xyz:443")).toBe("https://vault.mida.xyz")
    expect(canonicalizeOrigin("https://vault.mida.xyz:8443")).toBe("https://vault.mida.xyz:8443")
    expect(canonicalizeOrigin("http://localhost:5173", { allowLocalhost: true })).toBe("http://localhost:5173")
  })

  it("rejects paths, queries, fragments, credentials and non-local http", () => {
    for (const bad of [
      "https://vault.mida.xyz/", "https://vault.mida.xyz/x", "https://vault.mida.xyz?a=1",
      "https://vault.mida.xyz#f", "https://u:p@vault.mida.xyz", "http://vault.mida.xyz",
      "http://localhost:5173", "ftp://vault.mida.xyz", "not a url",
    ]) {
      expect(failsWith("INVALID_WIRE", () => canonicalizeOrigin(bad)), bad).toBe(true)
    }
  })

  it("hashes the UTF-8 canonical origin", () => {
    expect(originHash("https://vault.mida.xyz")).toBe(hashString("https://vault.mida.xyz"))
  })
})
