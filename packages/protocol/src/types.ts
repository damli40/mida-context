import type { Address, Hex } from "viem"
import type {
  ContextKind,
  Permission,
  ProvenancePolicy,
  ProvenanceSource,
  RecordRelation,
} from "./constants.js"

export type { Address, Hex }

/** §4.3 */
export interface AgentRecord {
  agentId: Hex
  operator: Address
  signer: Address
  encryptionPublicKey: Hex
  encryptionKeyVersion: number
  callbackOriginHash: Hex
  capabilityManifestHash: Hex
  capabilityManifestVersion: number
  active: boolean
}

/** §7.2 */
export interface ReadEpochState {
  readEpoch: bigint
  publicKey: Hex
  writeDeadline: bigint
}

/** §8.2 */
export interface RecordReference {
  relation: RecordRelation
  recordId: Hex
}

/**
 * Where a migrated record came from — sealed beside or inside the payload by `mida migrate`.
 * Declared here because ContextPayload carries it; `@mida/checkpoint` holds an identical
 * declaration beside StoredCheckpoint (that package stays dependency-free), and the two are
 * structurally interchangeable.
 */
export interface MigrationEnvelope {
  version: 1
  /** The chain the record was copied from, as a decimal string. */
  originalChainId: string
  /** The ContextRegistry the record lived on before the move. */
  originalContract: Address
  originalRecordId: Hex
  /** The old record's on-chain manifestHash. */
  originalCommitment: Hex
  /** The old record's on-chain author id. */
  originalAuthor: Hex
  /** When the record was first written — ISO-8601. */
  originalCreatedAt: string
  /** When the move happened — ISO-8601; its day is what "(moved on …)" renders. */
  migratedAt: string
}

export interface ContextPayload {
  v: 1
  value: string | Record<string, unknown>
  kind: ContextKind
  provenance: {
    source: ProvenanceSource
    extractionConfidence?: number
    references?: RecordReference[]
    sourceHash?: Hex
    sourceUri?: string
    retrievedAt?: number
    note?: string
  }
  tags?: string[]
  /**
   * The migration envelope of a moved record whose `value` is a string — a string cannot carry
   * the envelope inside, so it sits here, a sibling of `value`. An object `value` carries it at
   * `value.migration` instead, and an ordinary record carries no `migration` key at all.
   */
  migration?: MigrationEnvelope
}

/** §8.3 */
export interface EpochDEKWrap {
  v: 1
  contextId: Hex
  namespaceId: Hex
  readEpoch: string
  ephemeralPublicKey: Hex
  nonce: Hex
  wrappedDek: Hex
}

/** §8.4 */
export interface ReaderEpochWrap {
  v: 1
  owner: Address
  namespaceId: Hex
  readEpoch: string
  agentId: Hex
  agentKeyVersion: number
  ephemeralPublicKey: Hex
  nonce: Hex
  wrappedEpochPrivateKey: Hex
  createdAt: string
}

/** §9.1 */
export interface ObjectManifest {
  v: 1
  contextId: Hex
  ciphertextHash: Hex
  ciphertextSize: number
  payloadNonce: Hex
  cryptoVersion: "mida-crypto-v1"
  readEpoch: string
  epochDekWrap: EpochDEKWrap
}

/** §9.2 */
export interface StorageRef {
  provider: "memory" | "fs" | "mida-api" | "s3" | "ipfs"
  locator: string
}

/** §13.2. GrantScope (§10.4) has the same three fields. */
export interface RequestedScope {
  namespaceId: Hex
  permissions: number
  provenancePolicy: number
}
export type GrantScope = RequestedScope

export type PurposeId =
  | "general_assistance"
  | "career_coaching"
  | "project_assistance"
  | "travel_planning"

export interface AccessRequest {
  v: 1
  chainId: string
  capabilityRegistry: Address
  requestId: Hex
  nonce: Hex
  agentId: Hex
  purposeId: PurposeId
  callbackOrigin: string
  manifestHash: Hex
  manifestVersion: number
  policyVersion: "mida-grant-policy-v1"
  namespaceTreeVersion: "mida-namespace-tree-v1"
  scopes: RequestedScope[]
  issuedAt: string
  requestExpiresAt: string
  capabilityExpiresAt: string
  agentSignature: Hex
}

export interface GrantedCapability {
  namespaceId: Hex
  permissions: number
  provenancePolicy: number
  expiresAt: string
  capabilityId: Hex
  transactionHash: Hex
}

export interface AccessGrantResponse {
  v: 1
  chainId: string
  capabilityRegistry: Address
  requestId: Hex
  nonce: Hex
  requestHash: Hex
  owner: Address
  agentId: Hex
  manifestHash: Hex
  manifestVersion: number
  policyVersion: "mida-grant-policy-v1"
  namespaceTreeVersion: "mida-namespace-tree-v1"
  capabilities: GrantedCapability[]
}

/** §14.1 */
export interface PurposeDeclaration {
  id: PurposeId
  description: string
}

export interface ScopeDeclaration {
  purposeId: PurposeId
  namespace: string
  permissions: Permission[]
  provenancePolicies?: ProvenancePolicy[]
  reason: string
}

export interface AgentCapabilityManifestBody {
  v: 1
  agentId: Hex
  manifestVersion: number
  name: string
  purposes: PurposeDeclaration[]
  scopeDeclarations: ScopeDeclaration[]
  issuedAt: number
}

export interface SignedAgentCapabilityManifest {
  manifest: AgentCapabilityManifestBody
  operatorSignature: Hex
}

/** §14.5 */
export interface EffectiveAuthority {
  namespaceId: Hex
  permission: Permission
  provenancePolicy?: ProvenancePolicy
}

export interface OwnerAgentHistory {
  owner: Address
  agentId: Hex
  previouslyRevoked: boolean
  observedThroughBlock: bigint
}

/** §14.6 */
export type ScopeWarningCode =
  | "SCOPE_NOT_DECLARED"
  | "SCOPE_UNCLASSIFIED"
  | "SCOPE_ELEVATED"
  | "SCOPE_SUSPICIOUS"
  | "HIGH_SENSITIVITY"
  | "BROAD_PARENT_SCOPE"
  | "SUPERSEDE_ANY_EXPLICIT"
  | "PERMISSION_NARROWED"
  | "PROVENANCE_POLICY_NARROWED"
  | "DURATION_NARROWED"
  | "PREVIOUSLY_REVOKED"

export interface ScopeWarning {
  code: ScopeWarningCode
  namespaceId?: Hex
  relatedNamespaceIds?: Hex[]
  severity: "info" | "warning" | "critical"
  messageKey: string
}

export interface GrantAdvice {
  policyVersion: "mida-grant-policy-v1"
  namespaceTreeVersion: "mida-namespace-tree-v1"
  requestHash: Hex
  manifestHash: Hex
  manifestVersion: number
  recommended: RequestedScope[]
  recommendedExpiresAt: string
  warnings: ScopeWarning[]
  risk: "low" | "medium" | "high"
}
