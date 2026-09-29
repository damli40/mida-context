import {
  MidaError,
  NAMESPACE_TREE_VERSION,
  PERMISSION,
  POLICY_VERSION,
  accessRequestHash,
  assertCanonicalScopes,
  canonicalizeOrigin,
  decodeUint64,
  encodeUint64,
  expandNamespace,
  namespaceById,
  namespaceId,
  originHash,
} from "@mida/protocol"
import type {
  AccessRequest,
  AgentRecord,
  GrantAdvice,
  Hex,
  OwnerAgentHistory,
  PurposeId,
  RequestedScope,
  ScopeWarning,
  ScopeWarningCode,
  SignedAgentCapabilityManifest,
} from "@mida/protocol"
import { isExpiryWithin, isScopeSubset } from "./authority.js"
import { verifySignedManifest } from "./manifest.js"
import {
  DURATION_CAP_SECONDS,
  ELEVATED_PROVENANCE_BITS,
  WRITE_PERMISSION_BITS,
  classifyScope,
  isPurposeId,
  permissionBits,
  provenancePolicyBits,
  sensitivityOfId,
  stricterSensitivity,
} from "./policy.js"
import type { Sensitivity } from "./policy.js"
import { assertAccessRequestSignature } from "./signatures.js"

/** §14.5. There is deliberately no field for model output, explanations or reputation. */
export interface GrantAdvisorInput {
  request: AccessRequest
  manifest: SignedAgentCapabilityManifest
  agentRecord: AgentRecord
  ownerHistory: OwnerAgentHistory
  now: bigint
}

export const MAX_REQUEST_WINDOW_SECONDS = 600n

const SEVERITY: Readonly<Record<ScopeWarningCode, ScopeWarning["severity"]>> = {
  SCOPE_NOT_DECLARED: "warning",
  SCOPE_UNCLASSIFIED: "warning",
  SCOPE_ELEVATED: "warning",
  SCOPE_SUSPICIOUS: "critical",
  HIGH_SENSITIVITY: "critical",
  BROAD_PARENT_SCOPE: "warning",
  SUPERSEDE_ANY_EXPLICIT: "warning",
  PERMISSION_NARROWED: "info",
  PROVENANCE_POLICY_NARROWED: "info",
  DURATION_NARROWED: "info",
  PREVIOUSLY_REVOKED: "critical",
}

function warning(code: ScopeWarningCode, scopeId?: Hex, relatedNamespaceIds?: Hex[]): ScopeWarning {
  return {
    code,
    ...(scopeId === undefined ? {} : { namespaceId: scopeId }),
    ...(relatedNamespaceIds === undefined ? {} : { relatedNamespaceIds }),
    severity: SEVERITY[code],
    messageKey: `advisor.${code.toLowerCase()}`,
  }
}

/**
 * The request's own validity window. It needs only the request and the chain's clock — one
 * getBlock — so callers check it BEFORE paying for the agent-record and owner-history reads the
 * full advisor needs: an expired request refuses cheaply, with the same REQUEST_EXPIRED the
 * full check below would throw (in-15 J-2). assertRequestIsCurrent calls this too, so nothing
 * that reaches the signature checks escapes it.
 */
export function assertRequestFresh(request: AccessRequest, now: bigint): void {
  const issuedAt = decodeUint64(request.issuedAt)
  const requestExpiresAt = decodeUint64(request.requestExpiresAt)
  const capabilityExpiresAt = decodeUint64(request.capabilityExpiresAt)
  if (issuedAt > now || now >= requestExpiresAt || requestExpiresAt - issuedAt > MAX_REQUEST_WINDOW_SECONDS) {
    throw new MidaError("REQUEST_EXPIRED", "request is outside its validity window")
  }
  if (capabilityExpiresAt !== 0n && capabilityExpiresAt <= now) {
    throw new MidaError("REQUEST_EXPIRED", "requested capability expiry is not in the future")
  }
}

/** Algorithm step 1–2: every identity, manifest, signature, version and freshness check. Failure returns no advice. */
function assertRequestIsCurrent(input: GrantAdvisorInput): void {
  const { request, agentRecord, ownerHistory, now } = input
  if (request.policyVersion !== POLICY_VERSION) {
    throw new MidaError("POLICY_VERSION_UNSUPPORTED", String(request.policyVersion))
  }
  if (request.namespaceTreeVersion !== NAMESPACE_TREE_VERSION) {
    throw new MidaError("NAMESPACE_TREE_VERSION_UNSUPPORTED", String(request.namespaceTreeVersion))
  }
  if (request.v !== 1) throw new MidaError("INVALID_WIRE", "request v must be 1")
  if (!agentRecord.active) throw new MidaError("AGENT_ID_MISMATCH", "agent is not active")
  if (request.agentId.toLowerCase() !== agentRecord.agentId.toLowerCase()) {
    throw new MidaError("AGENT_ID_MISMATCH", "request agentId differs from the registered agent")
  }
  if (ownerHistory.agentId.toLowerCase() !== request.agentId.toLowerCase()) {
    throw new MidaError("AGENT_ID_MISMATCH", "owner history belongs to another agent")
  }

  const { bodyHash } = verifySignedManifest({
    envelope: input.manifest,
    agentRecord,
    chainId: decodeUint64(request.chainId),
    capabilityRegistry: request.capabilityRegistry,
    now,
  })
  if (request.manifestVersion !== agentRecord.capabilityManifestVersion) {
    throw new MidaError("MANIFEST_STALE", "request was made against an older manifest version")
  }
  if (request.manifestHash.toLowerCase() !== bodyHash) {
    throw new MidaError("MANIFEST_HASH_MISMATCH", "request manifest hash differs from the current manifest")
  }

  assertAccessRequestSignature(request, agentRecord.signer)

  const canonicalOrigin = canonicalizeOrigin(request.callbackOrigin, { allowLocalhost: true })
  if (canonicalOrigin !== request.callbackOrigin || originHash(canonicalOrigin) !== agentRecord.callbackOriginHash.toLowerCase()) {
    throw new MidaError("AGENT_ID_MISMATCH", "callback origin is not the agent's registered origin")
  }

  if (!isPurposeId(request.purposeId) || !input.manifest.manifest.purposes.some((purpose) => purpose.id === request.purposeId)) {
    throw new MidaError("PURPOSE_UNKNOWN", `purpose ${String(request.purposeId)} is not declared by the manifest`)
  }

  assertRequestFresh(request, now)
  assertCanonicalScopes(request.scopes)
}

/** Algorithm step 3: the manifest's declared bits for this purpose, expanded through tree v1. */
function declaredAuthority(manifest: SignedAgentCapabilityManifest, purposeId: PurposeId) {
  const declared = new Map<Hex, { permissions: number; provenancePolicy: number }>()
  for (const declaration of manifest.manifest.scopeDeclarations) {
    if (declaration.purposeId !== purposeId) continue
    const permissions = permissionBits(declaration.permissions)
    const provenancePolicy = provenancePolicyBits(declaration.provenancePolicies ?? [])
    for (const name of expandNamespace(declaration.namespace)) {
      const id = namespaceId(name)
      const prior = declared.get(id)
      declared.set(id, {
        permissions: (prior?.permissions ?? 0) | permissions,
        provenancePolicy: (prior?.provenancePolicy ?? 0) | provenancePolicy,
      })
    }
  }
  return declared
}

/**
 * §14.5 deterministic Grant Advisor. Pure and synchronous: identical input gives identical output.
 * The recommendation is always a subset of the signed request; the function throws rather than return one that is not.
 */
export function adviseGrant(input: GrantAdvisorInput): GrantAdvice {
  assertRequestIsCurrent(input)
  const { request, now } = input
  const declared = declaredAuthority(input.manifest, request.purposeId)
  const warnings: ScopeWarning[] = []
  const recommended: RequestedScope[] = []
  let highRisk = input.ownerHistory.previouslyRevoked
  let mediumRisk = false
  let strictest: Sensitivity | undefined

  for (const scope of request.scopes) {
    const id = scope.namespaceId
    const node = namespaceById(id)
    const sensitivity = sensitivityOfId(id)
    const rule = classifyScope(request.purposeId, id)
    const declaration = declared.get(id)
    let eligible = true

    if (sensitivity !== "LOW") mediumRisk = true
    if (sensitivity === "HIGH") {
      highRisk = true
      warnings.push(warning("HIGH_SENSITIVITY", id))
    }
    const expansion = expandNamespace(node.name)
    if (expansion.length > 1) warnings.push(warning("BROAD_PARENT_SCOPE", id, expansion.map(namespaceId)))
    if ((scope.permissions & PERMISSION.SUPERSEDE_ANY) !== 0) warnings.push(warning("SUPERSEDE_ANY_EXPLICIT", id))

    if (rule.classification === "SUSPICIOUS") {
      highRisk = true
      eligible = false
      warnings.push(warning("SCOPE_SUSPICIOUS", id))
    } else if (rule.classification === "ELEVATED") {
      eligible = false
      warnings.push(warning("SCOPE_ELEVATED", id))
    } else if (rule.classification === "UNCLASSIFIED") {
      eligible = false
      warnings.push(warning("SCOPE_UNCLASSIFIED", id))
    }
    if (declaration === undefined) {
      highRisk = true
      eligible = false
      warnings.push(warning("SCOPE_NOT_DECLARED", id))
    }
    if (!eligible || declaration === undefined) continue

    const permissions = scope.permissions & rule.permissions & declaration.permissions & ~PERMISSION.SUPERSEDE_ANY
    const provenancePolicy =
      (permissions & WRITE_PERMISSION_BITS) === 0
        ? 0
        : scope.provenancePolicy & rule.provenancePolicy & declaration.provenancePolicy & ~ELEVATED_PROVENANCE_BITS
    if (permissions !== scope.permissions) warnings.push(warning("PERMISSION_NARROWED", id))
    // A write bit that survives narrowing is what keeps provenance meaningful — when the write
    // itself was refused, provenance falls to 0 as a consequence, and PERMISSION_NARROWED alone
    // explains it. A second warning would blame a second cause that does not exist (in-32 X-3).
    if ((permissions & WRITE_PERMISSION_BITS) !== 0 && provenancePolicy !== scope.provenancePolicy) {
      warnings.push(warning("PROVENANCE_POLICY_NARROWED", id))
    }
    if (permissions === 0) continue
    recommended.push({ namespaceId: id, permissions, provenancePolicy })
    strictest = strictest === undefined ? sensitivity : stricterSensitivity(strictest, sensitivity)
  }

  const requestedExpiresAt = decodeUint64(request.capabilityExpiresAt)
  const cappedExpiresAt = now + DURATION_CAP_SECONDS[strictest ?? "LOW"]
  const recommendedExpiresAt =
    requestedExpiresAt === 0n || cappedExpiresAt < requestedExpiresAt ? cappedExpiresAt : requestedExpiresAt
  if (recommendedExpiresAt !== requestedExpiresAt) warnings.push(warning("DURATION_NARROWED"))
  if (input.ownerHistory.previouslyRevoked) warnings.push(warning("PREVIOUSLY_REVOKED"))

  const exceedsRequest =
    !isScopeSubset(recommended, request.scopes) ||
    !isExpiryWithin(recommendedExpiresAt, requestedExpiresAt) ||
    recommended.some(
      (scope) =>
        sensitivityOfId(scope.namespaceId) === "HIGH" ||
        (scope.permissions & PERMISSION.SUPERSEDE_ANY) !== 0 ||
        (scope.provenancePolicy & ELEVATED_PROVENANCE_BITS) !== 0,
    )
  if (exceedsRequest) throw new Error("grant advisor invariant violated: recommendation exceeds policy or request")

  const { agentSignature: _signature, ...unsigned } = request
  return {
    policyVersion: POLICY_VERSION,
    namespaceTreeVersion: NAMESPACE_TREE_VERSION,
    requestHash: accessRequestHash(unsigned),
    manifestHash: request.manifestHash,
    manifestVersion: request.manifestVersion,
    recommended,
    recommendedExpiresAt: encodeUint64(recommendedExpiresAt),
    warnings,
    risk: highRisk ? "high" : mediumRisk || warnings.length > 0 ? "medium" : "low",
  }
}
