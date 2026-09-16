// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// Protocol constants. Values mirror the TypeScript protocol package constants.ts (plan Task 2).
uint8 constant PERM_READ = 1;
uint8 constant PERM_CREATE = 2;
uint8 constant PERM_SUPERSEDE_OWN = 4;
uint8 constant PERM_SUPERSEDE_ANY = 8;
uint8 constant KNOWN_PERMISSION_BITS = 15;

uint8 constant PROV_ALLOW_INFERENCE = 1;
uint8 constant PROV_ALLOW_IMPORTED = 2;
uint8 constant PROV_ALLOW_EXTERNAL_ATTESTATION = 4;
uint8 constant KNOWN_PROVENANCE_BITS = 7;

uint8 constant RECORD_CONTEXT = 0;
uint8 constant RECORD_EVIDENCE = 1;

uint8 constant LINEAGE_STANDARD = 0;
uint8 constant LINEAGE_OWNER_CONTROLLED = 1;

uint8 constant KIND_NONE = 0;
uint8 constant KIND_MAX = 8;

uint8 constant SOURCE_NONE = 0;
uint8 constant SOURCE_USER_ASSERTED = 1;
uint8 constant SOURCE_USER_CONFIRMED = 2;
uint8 constant SOURCE_AGENT_INFERRED = 3;
uint8 constant SOURCE_IMPORTED = 4;
uint8 constant SOURCE_EXTERNAL_ATTESTATION = 5;

uint256 constant MAX_ACTIVE_PER_NAMESPACE = 32;
uint256 constant MAX_ACTIVE_PER_AGENT = 64;
uint64 constant HIGH_MAX_DURATION = 24 hours;
uint64 constant MAX_REQUEST_WINDOW = 600;

bytes32 constant POLICY_VERSION_HASH = keccak256("mida-grant-policy-v1");
bytes32 constant NAMESPACE_TREE_VERSION_HASH = keccak256("mida-namespace-tree-v1");

/// @dev Same fields and order as RequestedScope / GrantScope in the TypeScript protocol package.
struct GrantScope {
    bytes32 namespaceId;
    uint8 permissions;
    uint8 provenancePolicy;
}

/// @dev (relationCode, recordId) exactly as canonicalReferences() emits them.
struct EvidenceRef {
    uint8 relation;
    bytes32 recordId;
}

/// @dev Agent-signed access request submitted to grantBatch. Hash fields are computed off-chain
///      exactly as accessRequestTypedData() does; the contract recomputes scopesHash itself.
struct AccessRequestInput {
    bytes32 requestId;
    bytes32 nonce;
    bytes32 agentId;
    bytes32 purposeIdHash;
    bytes32 callbackOriginHash;
    bytes32 manifestHash;
    uint64 manifestVersion;
    bytes32 policyVersionHash;
    bytes32 namespaceTreeVersionHash;
    uint64 issuedAt;
    uint64 requestExpiresAt;
    uint64 capabilityExpiresAt;
    GrantScope[] scopes;
    bytes agentSignature;
}

struct GrantDigestInput {
    uint256 chainId;
    address capabilityRegistry;
    address owner;
    bytes32 agentId;
    bytes32 requestHash;
    bytes32 manifestHash;
    uint64 manifestVersion;
    bytes32 scopesHash;
    uint64 expiresAt;
    uint256 grantNonce;
}

struct AgentRegistration {
    bytes32 agentId;
    address operator;
    address signer;
    bytes32 encryptionPublicKey;
    uint32 encryptionKeyVersion;
    bytes32 callbackOriginHash;
    bytes32 capabilityManifestHash;
    uint64 capabilityManifestVersion;
}

// Custom errors. Names mirror spec §12.6 where one applies.
error InvalidNamespace(bytes32 namespaceId);
error CapabilityDenied();
error EpochRotationRequired(bytes32 namespaceId, uint64 epoch);
error EpochStale(bytes32 namespaceId, uint64 submitted, uint64 required);
error StaleParent(bytes32 expectedParentId, bytes32 currentHead);
error EvidenceImmutable(bytes32 parentId);
error ProvenanceForbidden();
error AnchorOwnerOnly();
