import { concat, encodeAbiParameters, hashTypedData, keccak256, zeroHash } from "viem"
import type { Address, Hex } from "./types.js"
import { midaDomain } from "./typed-data.js"

/** Why the contract skipped a save (SaveRejected.reason). Mirrors BatchAnchor.sol. */
export const BATCH_REJECT = {
  BAD_SIGNER: 1, BAD_SHAPE: 2, BAD_AREA: 3, BAD_EPOCH: 4, NO_AUTHORITY: 5, ALREADY_ANCHORED: 6, STALE_PARENT: 7,
} as const
export type BatchRejectReason = keyof typeof BATCH_REJECT

export const BATCH_ANCHOR_DOMAIN_NAME = "Mida Batch Anchor"

export const BATCH_SAVE_TYPES = {
  MidaBatchSaveV1: [
    { name: "owner", type: "address" },
    { name: "namespaceId", type: "bytes32" },
    { name: "objectNonce", type: "bytes32" },
    { name: "lineageId", type: "bytes32" },
    { name: "parentId", type: "bytes32" },
    { name: "parentVersion", type: "uint32" },
    { name: "rootAuthor", type: "bytes32" },
    { name: "manifestHash", type: "bytes32" },
    { name: "ciphertextCommitment", type: "bytes32" },
    { name: "readEpoch", type: "uint64" },
    { name: "expiresAt", type: "uint64" },
    { name: "kind", type: "uint8" },
    { name: "provenanceSource", type: "uint8" },
  ],
} as const

/** What an agent signs for one batched save. A new lineage has lineageId = parentId = rootAuthor = 0, parentVersion = 0. */
export interface BatchSaveMessage {
  owner: Address
  namespaceId: Hex
  objectNonce: Hex
  lineageId: Hex
  parentId: Hex
  parentVersion: number
  rootAuthor: Hex
  manifestHash: Hex
  ciphertextCommitment: Hex
  readEpoch: bigint
  expiresAt: bigint
  kind: number
  provenanceSource: number
}

export function batchSaveTypedData(input: { chainId: bigint; batchAnchor: Address; message: BatchSaveMessage }) {
  return {
    domain: midaDomain(BATCH_ANCHOR_DOMAIN_NAME, input.chainId, input.batchAnchor),
    types: BATCH_SAVE_TYPES,
    primaryType: "MidaBatchSaveV1" as const,
    message: input.message,
  }
}

export function batchSaveDigest(input: { chainId: bigint; batchAnchor: Address; message: BatchSaveMessage }): Hex {
  return hashTypedData(batchSaveTypedData(input))
}

const TYPE_STRING =
  "MidaBatchSaveV1(address owner,bytes32 namespaceId,bytes32 objectNonce,bytes32 lineageId,bytes32 parentId,uint32 parentVersion,bytes32 rootAuthor,bytes32 manifestHash,bytes32 ciphertextCommitment,uint64 readEpoch,uint64 expiresAt,uint8 kind,uint8 provenanceSource)"
export const BATCH_SAVE_TYPEHASH = keccak256(new TextEncoder().encode(TYPE_STRING))

/** The EIP-712 struct hash (not the digest); it is what the leaf binds. */
export function batchSaveStructHash(m: BatchSaveMessage): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" }, { type: "address" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" },
        { type: "bytes32" }, { type: "uint32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" },
        { type: "uint64" }, { type: "uint64" }, { type: "uint8" }, { type: "uint8" },
      ],
      [
        BATCH_SAVE_TYPEHASH, m.owner, m.namespaceId, m.objectNonce, m.lineageId, m.parentId, m.parentVersion,
        m.rootAuthor, m.manifestHash, m.ciphertextCommitment, m.readEpoch, m.expiresAt, m.kind, m.provenanceSource,
      ],
    ),
  )
}

export function batchContextId(i: {
  chainId: bigint; batchAnchor: Address; owner: Address; agentId: Hex; namespaceId: Hex; parentId: Hex; objectNonce: Hex
}): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "string" }, { type: "uint256" }, { type: "address" }, { type: "address" },
        { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" },
      ],
      ["MIDA_BATCH_CONTEXT_V1", i.chainId, i.batchAnchor, i.owner, i.agentId, i.namespaceId, i.parentId, i.objectNonce],
    ),
  )
}

export function batchLeafHash(i: { contextId: Hex; agentId: Hex; lineageId: Hex; version: number; structHash: Hex }): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "string" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint32" }, { type: "bytes32" }],
      ["MIDA_BATCH_LEAF_V1", i.contextId, i.agentId, i.lineageId, i.version, i.structHash],
    ),
  )
}

export function headCommit(i: { contextId: Hex; owner: Address; namespaceId: Hex; rootAuthor: Hex; version: number }): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "address" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint32" }],
      [i.contextId, i.owner, i.namespaceId, i.rootAuthor, i.version],
    ),
  )
}

/** Commutative pair hash: keccak256(min || max). Same as BatchMerkle.sol. */
function hashPair(a: Hex, b: Hex): Hex {
  return BigInt(a) < BigInt(b) ? keccak256(concat([a, b])) : keccak256(concat([b, a]))
}

/** Levels bottom-up; an odd last node is carried up unchanged. */
function levels(leaves: readonly Hex[]): Hex[][] {
  const out: Hex[][] = [leaves.slice()]
  while (out[out.length - 1]!.length > 1) {
    const level = out[out.length - 1]!
    const next: Hex[] = []
    for (let i = 0; i < level.length; i += 2) next.push(i + 1 < level.length ? hashPair(level[i]!, level[i + 1]!) : level[i]!)
    out.push(next)
  }
  return out
}

export function merkleRoot(leaves: readonly Hex[]): Hex {
  if (leaves.length === 0) return zeroHash
  const all = levels(leaves)
  return all[all.length - 1]![0]!
}

export function merkleProof(leaves: readonly Hex[], index: number): Hex[] {
  if (index < 0 || index >= leaves.length) throw new RangeError(`merkleProof: index ${index} out of range`)
  const proof: Hex[] = []
  let i = index
  for (const level of levels(leaves).slice(0, -1)) {
    const sibling = i % 2 === 0 ? i + 1 : i - 1
    if (sibling < level.length) proof.push(level[sibling]!)
    i = Math.floor(i / 2)
  }
  return proof
}

export function verifyMerkleProof(leaf: Hex, proof: readonly Hex[], root: Hex): boolean {
  let node = leaf
  for (const sibling of proof) node = hashPair(node, sibling)
  return node.toLowerCase() === root.toLowerCase()
}
