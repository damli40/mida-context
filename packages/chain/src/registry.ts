import { MidaError } from "@mida/protocol"
import type { AgentRecord, Hex, MidaErrorCode } from "@mida/protocol"
import { BaseError, ContractFunctionRevertedError, decodeErrorResult } from "viem"
import type { PublicClient } from "viem"
import { capabilityRegistryAbi, contextRegistryAbi } from "./abis.js"
import type { Deployment } from "./deployment.js"

export interface ChainContext {
  publicClient: PublicClient
  deployment: Deployment
}

/** Contract custom-error names mapped to protocol codes (§12.6 first, plan decision 3 codes otherwise). */
export const REVERT_CODES: Readonly<Record<string, MidaErrorCode>> = Object.freeze({
  AgentNotFound: "CAPABILITY_DENIED",
  AnchorOwnerOnly: "ANCHOR_OWNER_ONLY",
  AuthorityExceedsRequest: "RESPONSE_MISMATCH",
  CallbackOriginMismatch: "AGENT_ID_MISMATCH",
  CapabilityAlreadyRevoked: "CAPABILITY_REVOKED",
  CapabilityDenied: "CAPABILITY_DENIED",
  CapabilityNotFound: "CAPABILITY_DENIED",
  ContextIdMismatch: "COMMITMENT_MISMATCH",
  ContextNotFound: "NOT_FOUND",
  EpochRotationRequired: "EPOCH_ROTATION_REQUIRED",
  EpochStale: "EPOCH_STALE",
  EvidenceImmutable: "EVIDENCE_IMMUTABLE",
  ExpiryInvalid: "CAPABILITY_EXPIRED",
  HighSensitivityExpiry: "CAPABILITY_DENIED",
  InvalidNamespace: "INVALID_NAMESPACE",
  InvalidSignature: "REQUEST_SIGNATURE_INVALID",
  ManifestStale: "MANIFEST_STALE",
  ParentMismatch: "STALE_PARENT",
  ProvenanceForbidden: "PROVENANCE_FORBIDDEN",
  RequestExpired: "REQUEST_EXPIRED",
  StaleParent: "STALE_PARENT",
  VersionUnsupported: "POLICY_VERSION_UNSUPPORTED",
  WebAuthnInvalid: "AUTH_INVALID",
})

const ALL_ERRORS = [...capabilityRegistryAbi, ...contextRegistryAbi].filter((item) => item.type === "error")

export function revertNameFromData(data: Hex): string | undefined {
  try {
    return decodeErrorResult({ abi: ALL_ERRORS, data }).errorName
  } catch {
    return undefined
  }
}

export function revertName(error: unknown): string | undefined {
  if (!(error instanceof BaseError)) return undefined
  const reverted = error.walk((cause) => cause instanceof ContractFunctionRevertedError)
  if (reverted instanceof ContractFunctionRevertedError) {
    return reverted.data?.errorName ?? (reverted.raw === undefined ? undefined : revertNameFromData(reverted.raw))
  }
  return undefined
}

/** Returns a MidaError for a known contract revert; any other error is returned unchanged for rethrow. */
export function toMidaError(error: unknown): unknown {
  const name = revertName(error)
  const code = name === undefined ? undefined : REVERT_CODES[name]
  return code === undefined ? error : new MidaError(code, `contract reverted ${name}`)
}

export async function readAgentRecord(context: ChainContext, agentId: Hex): Promise<AgentRecord> {
  try {
    const record = await context.publicClient.readContract({
      address: context.deployment.capabilityRegistry,
      abi: capabilityRegistryAbi,
      functionName: "getAgent",
      args: [agentId],
    })
    return {
      agentId: agentId.toLowerCase() as Hex,
      operator: record.operator.toLowerCase() as Hex,
      signer: record.signer.toLowerCase() as Hex,
      encryptionPublicKey: record.encryptionPublicKey,
      encryptionKeyVersion: record.encryptionKeyVersion,
      callbackOriginHash: record.callbackOriginHash,
      capabilityManifestHash: record.capabilityManifestHash,
      capabilityManifestVersion: Number(record.capabilityManifestVersion),
      active: record.active,
    }
  } catch (error) {
    throw toMidaError(error)
  }
}

/** Chain time, not wall-clock time, decides expiry so the API and the contracts use one clock (Part D note). */
export async function latestTimestamp(context: ChainContext): Promise<bigint> {
  return (await context.publicClient.getBlock({ blockTag: "latest" })).timestamp
}
