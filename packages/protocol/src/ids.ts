import { encodeAbiParameters, keccak256, stringToBytes, zeroHash } from "viem"
import type { Address, Hex } from "viem"
import {
  KNOWN_PERMISSION_BITS,
  KNOWN_PROVENANCE_BITS,
  NAMESPACE_TREE_VERSION,
  POLICY_VERSION,
  RECORD_RELATION_CODE,
} from "./constants.js"
import { MidaError } from "./errors.js"
import { namespaceById } from "./namespaces.js"
import type { GrantScope, RecordReference, RequestedScope } from "./types.js"
import { assertHex } from "./wire.js"

export const OWNER_AUTHOR_ID: Hex = zeroHash

export const hashString = (value: string): Hex => keccak256(stringToBytes(value))
export const POLICY_VERSION_HASH: Hex = hashString(POLICY_VERSION)
export const NAMESPACE_TREE_VERSION_HASH: Hex = hashString(NAMESPACE_TREE_VERSION)

export function agentId(input: {
  chainId: bigint
  capabilityRegistry: Address
  operator: Address
  agentSalt: Hex
}): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "string" }, { type: "uint256" }, { type: "address" }, { type: "address" }, { type: "bytes32" }],
      ["MIDA_AGENT_V1", input.chainId, input.capabilityRegistry, input.operator, input.agentSalt],
    ),
  )
}

export function contextId(input: {
  chainId: bigint
  contextRegistry: Address
  owner: Address
  authorId: Hex
  namespaceId: Hex
  objectNonce: Hex
}): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "string" }, { type: "uint256" }, { type: "address" }, { type: "address" },
        { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" },
      ],
      [
        "MIDA_CONTEXT_OBJECT_V1", input.chainId, input.contextRegistry, input.owner,
        input.authorId, input.namespaceId, input.objectNonce,
      ],
    ),
  )
}

const SCOPE_ARRAY = {
  type: "tuple[]",
  components: [
    { name: "namespaceId", type: "bytes32" },
    { name: "permissions", type: "uint8" },
    { name: "provenancePolicy", type: "uint8" },
  ],
} as const

export function sortScopes<T extends RequestedScope>(scopes: readonly T[]): T[] {
  return [...scopes].sort((a, b) => (a.namespaceId < b.namespaceId ? -1 : a.namespaceId > b.namespaceId ? 1 : 0))
}

export function assertCanonicalScopes(scopes: readonly RequestedScope[]): void {
  if (scopes.length === 0) throw new MidaError("INVALID_WIRE", "scopes must be non-empty")
  let previous: string | undefined
  for (const scope of scopes) {
    assertHex(scope.namespaceId, 32)
    namespaceById(scope.namespaceId)
    if (previous !== undefined && scope.namespaceId <= previous) {
      throw new MidaError("INVALID_WIRE", "scopes must be strictly ascending by namespaceId")
    }
    const { permissions, provenancePolicy } = scope
    if (
      !Number.isInteger(permissions) ||
      permissions <= 0 ||
      permissions > KNOWN_PERMISSION_BITS ||
      (permissions & ~KNOWN_PERMISSION_BITS) !== 0
    ) {
      throw new MidaError("INVALID_WIRE", "permissions must be non-zero known bits")
    }
    if (
      !Number.isInteger(provenancePolicy) ||
      provenancePolicy < 0 ||
      provenancePolicy > KNOWN_PROVENANCE_BITS ||
      (provenancePolicy & ~KNOWN_PROVENANCE_BITS) !== 0
    ) {
      throw new MidaError("INVALID_WIRE", "provenancePolicy must be known bits")
    }
    previous = scope.namespaceId
  }
}

/** Hashes in the order given. Call sortScopes and assertCanonicalScopes first. */
export function scopesHash(scopes: readonly RequestedScope[]): Hex {
  return keccak256(
    encodeAbiParameters(
      [SCOPE_ARRAY],
      [scopes.map((s) => ({ namespaceId: s.namespaceId, permissions: s.permissions, provenancePolicy: s.provenancePolicy }))],
    ),
  )
}

export function capabilityId(input: {
  owner: Address
  agentId: Hex
  grantNonce: bigint
  index: bigint
  namespaceId: Hex
  permissions: number
  provenancePolicy: number
  expiresAt: bigint
}): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "string" }, { type: "address" }, { type: "bytes32" }, { type: "uint256" }, { type: "uint256" },
        { type: "bytes32" }, { type: "uint8" }, { type: "uint8" }, { type: "uint64" },
      ],
      [
        "MIDA_CAPABILITY_V1", input.owner, input.agentId, input.grantNonce, input.index,
        input.namespaceId, input.permissions, input.provenancePolicy, input.expiresAt,
      ],
    ),
  )
}

export function grantDigest(input: {
  chainId: bigint
  capabilityRegistry: Address
  owner: Address
  agentId: Hex
  requestHash: Hex
  manifestHash: Hex
  manifestVersion: bigint
  finalScopes: readonly GrantScope[]
  expiresAt: bigint
  grantNonce: bigint
}): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "string" }, { type: "uint256" }, { type: "address" }, { type: "address" },
        { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint64" },
        { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint64" }, { type: "uint256" },
      ],
      [
        "MIDA_GRANT_V1", input.chainId, input.capabilityRegistry, input.owner,
        input.agentId, input.requestHash, input.manifestHash, input.manifestVersion,
        POLICY_VERSION_HASH, NAMESPACE_TREE_VERSION_HASH, scopesHash(input.finalScopes), input.expiresAt, input.grantNonce,
      ],
    ),
  )
}

export interface CanonicalReference {
  relationCode: number
  recordId: Hex
}

export function canonicalReferences(references: readonly RecordReference[]): CanonicalReference[] {
  const mapped = references.map((reference) => {
    if (!Object.hasOwn(RECORD_RELATION_CODE, reference.relation)) {
      throw new MidaError("INVALID_WIRE", `unknown relation ${String(reference.relation)}`)
    }
    return { relationCode: RECORD_RELATION_CODE[reference.relation], recordId: assertHex(reference.recordId, 32) }
  })
  mapped.sort((a, b) => a.relationCode - b.relationCode || (a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0))
  return mapped.filter((reference, index) => {
    const prior = mapped[index - 1]
    return prior === undefined || prior.relationCode !== reference.relationCode || prior.recordId !== reference.recordId
  })
}

export function evidenceCommitment(references: readonly RecordReference[]): Hex {
  const canonical = canonicalReferences(references)
  return keccak256(
    encodeAbiParameters(
      [
        { type: "string" },
        { type: "tuple[]", components: [{ name: "relation", type: "uint8" }, { name: "recordId", type: "bytes32" }] },
      ],
      ["MIDA_EVIDENCE_V1", canonical.map((r) => ({ relation: r.relationCode, recordId: r.recordId }))],
    ),
  )
}

export function p256RotationDigest(input: {
  chainId: bigint
  capabilityRegistry: Address
  owner: Address
  newQx: bigint
  newQy: bigint
  nonce: bigint
}): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "string" }, { type: "uint256" }, { type: "address" }, { type: "address" },
        { type: "uint256" }, { type: "uint256" }, { type: "uint256" },
      ],
      ["MIDA_ROTATE_P256_V1", input.chainId, input.capabilityRegistry, input.owner, input.newQx, input.newQy, input.nonce],
    ),
  )
}

export function cancelFastRevokeDigest(input: {
  chainId: bigint
  capabilityRegistry: Address
  owner: Address
  revocationIntentId: Hex
  apiCancellationNonce: bigint
  expiresAt: bigint
}): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "string" }, { type: "uint256" }, { type: "address" }, { type: "address" },
        { type: "bytes32" }, { type: "uint256" }, { type: "uint64" },
      ],
      [
        "MIDA_CANCEL_FAST_REVOKE_V1", input.chainId, input.capabilityRegistry, input.owner,
        input.revocationIntentId, input.apiCancellationNonce, input.expiresAt,
      ],
    ),
  )
}

const ORIGIN_SHAPE = /^[a-z][a-z0-9+.-]*:\/\/[^/?#@]+$/i

export function canonicalizeOrigin(input: string, options: { allowLocalhost?: boolean } = {}): string {
  const trimmed = input.trim()
  if (!ORIGIN_SHAPE.test(trimmed)) {
    throw new MidaError("INVALID_WIRE", "origin must have no path, query, fragment or credentials")
  }
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new MidaError("INVALID_WIRE", "origin is not a URL")
  }
  if (url.protocol === "https:") return url.origin
  if (url.protocol === "http:" && options.allowLocalhost === true && url.hostname === "localhost" && url.port !== "") {
    return url.origin
  }
  throw new MidaError("INVALID_WIRE", "origin must be https, or http://localhost:<port> in local development")
}

export const originHash = (canonicalOrigin: string): Hex => hashString(canonicalOrigin)
