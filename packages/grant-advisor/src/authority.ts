import {
  KNOWN_PERMISSION_BITS,
  KNOWN_PROVENANCE_BITS,
  MidaError,
  accessRequestHash,
  assertCanonicalScopes,
  decodeUint64,
  expandNamespace,
  namespaceId,
  sortScopes,
} from "@mida/protocol"
import type { AccessGrantResponse, AccessRequest, EffectiveAuthority, GrantScope, Hex, RequestedScope } from "@mida/protocol"
import { POLICY_DOCUMENT_V1, permissionNames, provenancePolicyNames, sensitivityOfId } from "./policy.js"

export const HIGH_FINAL_SELECTION_CAP_SECONDS = BigInt(POLICY_DOCUMENT_V1.rules.highFinalSelectionCapSeconds)

/** Builder-facing scope: a namespace string (parent allowed) plus permission and provenance bits. */
export interface ScopeInput {
  namespace: string
  permissions: number
  provenancePolicy?: number
}

/**
 * Bitwise operators truncate to 32 bits, so every value must be bound-checked before `&` or `|`
 * touches it: without `<= KNOWN_*_BITS`, `2**32 + 1` would compare as plain `1`.
 */
function assertBits(permissions: number, provenancePolicy: number): void {
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
}

const withinKnownBits = (permissions: number, provenancePolicy: number): boolean =>
  Number.isInteger(permissions) &&
  permissions > 0 &&
  permissions <= KNOWN_PERMISSION_BITS &&
  Number.isInteger(provenancePolicy) &&
  provenancePolicy >= 0 &&
  provenancePolicy <= KNOWN_PROVENANCE_BITS

/**
 * §5.3: canonicalize every namespace, expand parents through frozen tree v1, merge bits per exact
 * namespace, and return sorted canonical scopes. This is the only way builder input becomes signed authority.
 */
export function expandScopeInputs(inputs: readonly ScopeInput[]): RequestedScope[] {
  const merged = new Map<Hex, { permissions: number; provenancePolicy: number }>()
  for (const input of inputs) {
    const provenancePolicy = input.provenancePolicy ?? 0
    assertBits(input.permissions, provenancePolicy)
    for (const name of expandNamespace(input.namespace)) {
      const id = namespaceId(name)
      const prior = merged.get(id)
      merged.set(id, {
        permissions: (prior?.permissions ?? 0) | input.permissions,
        provenancePolicy: (prior?.provenancePolicy ?? 0) | provenancePolicy,
      })
    }
  }
  const scopes = sortScopes([...merged].map(([id, bits]) => ({ namespaceId: id, ...bits })))
  assertCanonicalScopes(scopes)
  return scopes
}

/**
 * §14.5 exact authority tuples: one per (namespace, permission), plus one per (namespace, permission, provenance policy).
 * Tuple containment is equivalent to per-namespace bit containment; a property test proves it.
 */
export function effectiveAuthority(scopes: readonly RequestedScope[]): EffectiveAuthority[] {
  assertCanonicalScopes(scopes)
  const tuples: EffectiveAuthority[] = []
  for (const scope of scopes) {
    for (const permission of permissionNames(scope.permissions)) {
      tuples.push({ namespaceId: scope.namespaceId, permission })
      for (const provenancePolicy of provenancePolicyNames(scope.provenancePolicy)) {
        tuples.push({ namespaceId: scope.namespaceId, permission, provenancePolicy })
      }
    }
  }
  return tuples
}

export const authorityKey = (tuple: EffectiveAuthority): string =>
  `${tuple.namespaceId.toLowerCase()}:${tuple.permission}:${tuple.provenancePolicy ?? "-"}`

export function isAuthoritySubset(candidate: readonly EffectiveAuthority[], requested: readonly EffectiveAuthority[]): boolean {
  const allowed = new Set(requested.map(authorityKey))
  return candidate.every((tuple) => allowed.has(authorityKey(tuple)))
}

/**
 * Same rule the contract enforces in grantBatch: every candidate namespace is requested, with no extra bits.
 * Out-of-range bit values on either side fail the bound check before any bitwise operator runs.
 */
export function isScopeSubset(candidate: readonly RequestedScope[], requested: readonly RequestedScope[]): boolean {
  const byId = new Map(requested.map((scope) => [scope.namespaceId.toLowerCase(), scope]))
  return candidate.every((scope) => {
    const match = byId.get(scope.namespaceId.toLowerCase())
    return (
      match !== undefined &&
      withinKnownBits(scope.permissions, scope.provenancePolicy) &&
      withinKnownBits(match.permissions, match.provenancePolicy) &&
      (scope.permissions & ~match.permissions) === 0 &&
      (scope.provenancePolicy & ~match.provenancePolicy) === 0
    )
  })
}

/** A shorter expiry is narrower. Requested 0 means unbounded, so any value fits; a finite request never becomes unbounded. */
export function isExpiryWithin(candidate: bigint, requested: bigint): boolean {
  return requested === 0n || (candidate !== 0n && candidate <= requested)
}

/**
 * The user's final choice (§14.5, §14.4, §10.4 rule 7). Used by FakeVault before signing and by the SDK on completion.
 * The user may pick ELEVATED or undeclared authority, but never anything outside the signed request.
 */
export function assertFinalSelection(input: {
  requestedScopes: readonly RequestedScope[]
  requestedExpiresAt: bigint
  finalScopes: readonly GrantScope[]
  finalExpiresAt: bigint
  now: bigint
}): void {
  assertCanonicalScopes(input.finalScopes)
  if (!isScopeSubset(input.finalScopes, input.requestedScopes)) {
    throw new MidaError("RESPONSE_MISMATCH", "final authority is not a subset of the signed request")
  }
  if (!isExpiryWithin(input.finalExpiresAt, input.requestedExpiresAt)) {
    throw new MidaError("RESPONSE_MISMATCH", "final expiry is later than the signed request")
  }
  if (input.finalExpiresAt !== 0n && input.finalExpiresAt <= input.now) {
    throw new MidaError("CAPABILITY_EXPIRED", "final expiry is not in the future")
  }
  const includesHigh = input.finalScopes.some((scope) => sensitivityOfId(scope.namespaceId) === "HIGH")
  if (includesHigh && (input.finalExpiresAt === 0n || input.finalExpiresAt > input.now + HIGH_FINAL_SELECTION_CAP_SECONDS)) {
    throw new MidaError("CAPABILITY_DENIED", "HIGH authority requires a finite expiry within 24 hours")
  }
}

/**
 * §13.3 off-chain half of completeAccessRequest: the response must echo the original request and grant only a
 * subset of it with one expiry. Returns the sorted final scopes. The SDK must still prove each capability exists
 * and is currently valid on Monad (Task 25); this function never reads the chain.
 */
export function assertGrantResponseWithinRequest(request: AccessRequest, response: AccessGrantResponse, now: bigint): GrantScope[] {
  const mismatch = (field: string): never => {
    throw new MidaError("RESPONSE_MISMATCH", `response ${field} does not match the original request`)
  }
  const { agentSignature: _signature, ...unsigned } = request
  if (response.v !== 1) mismatch("v")
  if (response.chainId !== request.chainId) mismatch("chainId")
  if (response.capabilityRegistry.toLowerCase() !== request.capabilityRegistry.toLowerCase()) mismatch("capabilityRegistry")
  if (response.requestId.toLowerCase() !== request.requestId.toLowerCase()) mismatch("requestId")
  if (response.nonce.toLowerCase() !== request.nonce.toLowerCase()) mismatch("nonce")
  if (response.agentId.toLowerCase() !== request.agentId.toLowerCase()) mismatch("agentId")
  if (response.manifestHash.toLowerCase() !== request.manifestHash.toLowerCase()) mismatch("manifestHash")
  if (response.manifestVersion !== request.manifestVersion) mismatch("manifestVersion")
  if (response.policyVersion !== request.policyVersion) mismatch("policyVersion")
  if (response.namespaceTreeVersion !== request.namespaceTreeVersion) mismatch("namespaceTreeVersion")
  if (response.requestHash.toLowerCase() !== accessRequestHash(unsigned)) mismatch("requestHash")
  const [first, ...rest] = response.capabilities
  if (first === undefined) return mismatch("capabilities (empty)")
  if (rest.some((capability) => capability.expiresAt !== first.expiresAt)) mismatch("expiresAt (one expiry per batch)")
  const finalScopes = sortScopes(
    response.capabilities.map((capability) => ({
      namespaceId: capability.namespaceId,
      permissions: capability.permissions,
      provenancePolicy: capability.provenancePolicy,
    })),
  )
  assertFinalSelection({
    requestedScopes: request.scopes,
    requestedExpiresAt: decodeUint64(request.capabilityExpiresAt),
    finalScopes,
    finalExpiresAt: decodeUint64(first.expiresAt),
    now,
  })
  return finalScopes
}
