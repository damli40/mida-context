import { hashTypedData, keccak256 } from "viem"
import type { Address, Hex } from "viem"
import { hashString, originHash, scopesHash } from "./ids.js"
import type { AccessRequest } from "./types.js"
import { decodeUint64 } from "./wire.js"

export type UnsignedAccessRequest = Omit<AccessRequest, "agentSignature">

export const DOMAIN_NAMES = {
  capabilityRegistry: "Mida Capability Registry",
  accessRequest: "Mida Context",
  manifest: "Mida Agent Capability Manifest",
  httpRequest: "Mida Context API",
} as const

export function midaDomain(name: string, chainId: bigint, verifyingContract: Address) {
  return { name, version: "1", chainId, verifyingContract }
}

export const ACCESS_REQUEST_TYPES = {
  MidaAccessRequestV1: [
    { name: "requestId", type: "bytes32" },
    { name: "nonce", type: "bytes32" },
    { name: "agentId", type: "bytes32" },
    { name: "purposeIdHash", type: "bytes32" },
    { name: "callbackOriginHash", type: "bytes32" },
    { name: "manifestHash", type: "bytes32" },
    { name: "manifestVersion", type: "uint64" },
    { name: "policyVersionHash", type: "bytes32" },
    { name: "namespaceTreeVersionHash", type: "bytes32" },
    { name: "scopesHash", type: "bytes32" },
    { name: "issuedAt", type: "uint64" },
    { name: "requestExpiresAt", type: "uint64" },
    { name: "capabilityExpiresAt", type: "uint64" },
  ],
} as const

export const MANIFEST_BINDING_TYPES = {
  ManifestBinding: [
    { name: "bodyHash", type: "bytes32" },
    { name: "agentId", type: "bytes32" },
    { name: "manifestVersion", type: "uint64" },
  ],
} as const

export const HTTP_REQUEST_TYPES = {
  MidaHttpRequestV1: [
    { name: "signer", type: "address" },
    { name: "methodHash", type: "bytes32" },
    { name: "targetHash", type: "bytes32" },
    { name: "bodyHash", type: "bytes32" },
    { name: "timestamp", type: "uint64" },
    { name: "nonce", type: "bytes32" },
  ],
} as const

export const AGENT_REGISTRATION_TYPES = {
  MidaAgentRegistrationV1: [
    { name: "agentId", type: "bytes32" },
    { name: "operator", type: "address" },
    { name: "signer", type: "address" },
    { name: "encryptionPublicKey", type: "bytes32" },
    { name: "encryptionKeyVersion", type: "uint32" },
    { name: "callbackOriginHash", type: "bytes32" },
    { name: "capabilityManifestHash", type: "bytes32" },
    { name: "capabilityManifestVersion", type: "uint64" },
  ],
} as const

export const SIGNER_ROTATION_TYPES = {
  MidaSignerRotationV1: [
    { name: "agentId", type: "bytes32" },
    { name: "newSigner", type: "address" },
    { name: "rotationNonce", type: "uint64" },
  ],
} as const

export function accessRequestTypedData(request: UnsignedAccessRequest) {
  return {
    domain: midaDomain(DOMAIN_NAMES.accessRequest, decodeUint64(request.chainId), request.capabilityRegistry),
    types: ACCESS_REQUEST_TYPES,
    primaryType: "MidaAccessRequestV1" as const,
    message: {
      requestId: request.requestId,
      nonce: request.nonce,
      agentId: request.agentId,
      purposeIdHash: hashString(request.purposeId),
      callbackOriginHash: originHash(request.callbackOrigin),
      manifestHash: request.manifestHash,
      manifestVersion: BigInt(request.manifestVersion),
      policyVersionHash: hashString(request.policyVersion),
      namespaceTreeVersionHash: hashString(request.namespaceTreeVersion),
      scopesHash: scopesHash(request.scopes),
      issuedAt: decodeUint64(request.issuedAt),
      requestExpiresAt: decodeUint64(request.requestExpiresAt),
      capabilityExpiresAt: decodeUint64(request.capabilityExpiresAt),
    },
  }
}

export const accessRequestHash = (request: UnsignedAccessRequest): Hex =>
  hashTypedData(accessRequestTypedData(request))

export function manifestBindingTypedData(input: {
  chainId: bigint
  capabilityRegistry: Address
  bodyHash: Hex
  agentId: Hex
  manifestVersion: bigint
}) {
  return {
    domain: midaDomain(DOMAIN_NAMES.manifest, input.chainId, input.capabilityRegistry),
    types: MANIFEST_BINDING_TYPES,
    primaryType: "ManifestBinding" as const,
    message: { bodyHash: input.bodyHash, agentId: input.agentId, manifestVersion: input.manifestVersion },
  }
}

export function canonicalTarget(pathname: string, query: Record<string, string> = {}): string {
  const keys = Object.keys(query).sort()
  if (keys.length === 0) return pathname
  const pairs = keys.map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(query[key]!)}`)
  return `${pathname}?${pairs.join("&")}`
}

export function httpRequestTypedData(input: {
  chainId: bigint
  capabilityRegistry: Address
  signer: Address
  method: string
  target: string
  body: Uint8Array
  timestamp: bigint
  nonce: Hex
}) {
  return {
    domain: midaDomain(DOMAIN_NAMES.httpRequest, input.chainId, input.capabilityRegistry),
    types: HTTP_REQUEST_TYPES,
    primaryType: "MidaHttpRequestV1" as const,
    message: {
      signer: input.signer,
      methodHash: hashString(input.method.toUpperCase()),
      targetHash: hashString(input.target),
      bodyHash: keccak256(input.body),
      timestamp: input.timestamp,
      nonce: input.nonce,
    },
  }
}

export function agentRegistrationTypedData(input: {
  chainId: bigint
  capabilityRegistry: Address
  agentId: Hex
  operator: Address
  signer: Address
  encryptionPublicKey: Hex
  encryptionKeyVersion: number
  callbackOriginHash: Hex
  capabilityManifestHash: Hex
  capabilityManifestVersion: bigint
}) {
  return {
    domain: midaDomain(DOMAIN_NAMES.capabilityRegistry, input.chainId, input.capabilityRegistry),
    types: AGENT_REGISTRATION_TYPES,
    primaryType: "MidaAgentRegistrationV1" as const,
    message: {
      agentId: input.agentId,
      operator: input.operator,
      signer: input.signer,
      encryptionPublicKey: input.encryptionPublicKey,
      encryptionKeyVersion: input.encryptionKeyVersion,
      callbackOriginHash: input.callbackOriginHash,
      capabilityManifestHash: input.capabilityManifestHash,
      capabilityManifestVersion: input.capabilityManifestVersion,
    },
  }
}

export function signerRotationTypedData(input: {
  chainId: bigint
  capabilityRegistry: Address
  agentId: Hex
  newSigner: Address
  rotationNonce: bigint
}) {
  return {
    domain: midaDomain(DOMAIN_NAMES.capabilityRegistry, input.chainId, input.capabilityRegistry),
    types: SIGNER_ROTATION_TYPES,
    primaryType: "MidaSignerRotationV1" as const,
    message: { agentId: input.agentId, newSigner: input.newSigner, rotationNonce: input.rotationNonce },
  }
}
