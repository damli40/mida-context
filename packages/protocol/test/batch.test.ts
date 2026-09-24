import { describe, expect, it } from "vitest"
import { keccak256, toHex, zeroHash } from "viem"
import {
  batchContextId, batchLeafHash, batchSaveStructHash, headCommit, merkleProof, merkleRoot, verifyMerkleProof,
} from "../src/batch.js"

const leaves = Array.from({ length: 7 }, (_, i) => keccak256(toHex(`leaf-${i}`)))

describe("merkle", () => {
  it("empty root is zero, single root is the leaf", () => {
    expect(merkleRoot([])).toBe(zeroHash)
    expect(merkleRoot([leaves[0]!])).toBe(leaves[0])
  })
  it("every proof verifies for sizes 1..7, and a wrong leaf fails", () => {
    for (let n = 1; n <= 7; n += 1) {
      const set = leaves.slice(0, n)
      const root = merkleRoot(set)
      set.forEach((leaf, i) => expect(verifyMerkleProof(leaf, merkleProof(set, i), root)).toBe(true))
      expect(verifyMerkleProof(keccak256(toHex("outsider")), merkleProof(set, 0), root)).toBe(false)
    }
  })
})

describe("ids", () => {
  const base = {
    chainId: 10143n, batchAnchor: "0x1111111111111111111111111111111111111111" as const,
    owner: "0x2222222222222222222222222222222222222222" as const, agentId: keccak256(toHex("agent")),
    namespaceId: keccak256(toHex("ns")), objectNonce: keccak256(toHex("nonce")),
  }
  it("the parent changes the id (nonce reuse cannot collide)", () => {
    expect(batchContextId({ ...base, parentId: zeroHash })).not.toBe(batchContextId({ ...base, parentId: keccak256(toHex("p")) }))
  })
  it("leaf and headCommit are deterministic and field-sensitive", () => {
    const message = {
      owner: base.owner, namespaceId: base.namespaceId, objectNonce: base.objectNonce, lineageId: zeroHash,
      parentId: zeroHash, parentVersion: 0, rootAuthor: zeroHash, manifestHash: keccak256(toHex("m")),
      ciphertextCommitment: keccak256(toHex("c")), readEpoch: 1n, expiresAt: 0n, kind: 5, provenanceSource: 3,
    }
    const structHash = batchSaveStructHash(message)
    const contextId = batchContextId({ ...base, parentId: zeroHash })
    const leaf = (version: number) => batchLeafHash({ contextId, agentId: base.agentId, lineageId: contextId, version, structHash })
    expect(leaf(1)).toBe(leaf(1))
    expect(leaf(1)).not.toBe(leaf(2))
    const commit = (version: number) => headCommit({ contextId, owner: base.owner, namespaceId: base.namespaceId, rootAuthor: base.agentId, version })
    expect(commit(1)).not.toBe(commit(2))
  })
})
