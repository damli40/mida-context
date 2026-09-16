// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {
    AnchorOwnerOnly,
    CapabilityDenied,
    EpochRotationRequired,
    EpochStale,
    EvidenceImmutable,
    InvalidNamespace,
    KIND_MAX,
    KIND_NONE,
    LINEAGE_OWNER_CONTROLLED,
    LINEAGE_STANDARD,
    PERM_CREATE,
    PERM_SUPERSEDE_ANY,
    PERM_SUPERSEDE_OWN,
    PROV_ALLOW_EXTERNAL_ATTESTATION,
    PROV_ALLOW_IMPORTED,
    PROV_ALLOW_INFERENCE,
    ProvenanceForbidden,
    RECORD_CONTEXT,
    RECORD_EVIDENCE,
    SOURCE_AGENT_INFERRED,
    SOURCE_EXTERNAL_ATTESTATION,
    SOURCE_IMPORTED,
    SOURCE_NONE,
    SOURCE_USER_ASSERTED,
    SOURCE_USER_CONFIRMED,
    StaleParent
} from "./MidaTypes.sol";
import {ICapabilityRegistry} from "./ICapabilityRegistry.sol";
import {MidaHashing} from "./MidaHashing.sol";

/// @notice Immutable context and evidence records with contract-derived authorship, provenance rules
///         and lineage (spec §11). Holds no epoch keys: every write reads epoch validity from
///         CapabilityRegistry. No plaintext is ever stored here, only commitments.
contract ContextRegistry {
    struct ContextInput {
        bytes32 contextId;
        bytes32 objectNonce;
        bytes32 namespaceId;
        bytes32 expectedParentId;
        bytes32 manifestHash;
        bytes32 ciphertextCommitment;
        bytes32 evidenceCommitment;
        uint64 readEpoch;
        uint64 expiresAt;
        uint8 recordType;
        uint8 lineagePolicy;
        uint8 kind;
        uint8 provenanceSource;
    }

    struct ContextRecord {
        bytes32 contextId;
        address owner;
        bytes32 author;
        bytes32 namespaceId;
        bytes32 lineageId;
        bytes32 parentId;
        bytes32 manifestHash;
        bytes32 ciphertextCommitment;
        bytes32 evidenceCommitment;
        uint64 readEpoch;
        uint64 createdAt;
        uint64 expiresAt;
        uint32 version;
        uint8 recordType;
        uint8 lineagePolicy;
        uint8 kind;
        uint8 provenanceSource;
    }

    error ZeroRegistry();
    error EmptyBatch();
    error InvalidRecord(bytes32 contextId);
    error ContextIdMismatch(bytes32 expected, bytes32 submitted);
    error DuplicateContext(bytes32 contextId);
    error ContextNotFound(bytes32 contextId);
    error ParentMismatch(bytes32 parentId);

    ICapabilityRegistry public immutable CAPABILITY_REGISTRY;

    mapping(bytes32 contextId => ContextRecord) private _records;
    mapping(bytes32 lineageId => bytes32 contextId) private _latest;

    event ContextRegistered(
        address indexed owner, bytes32 indexed namespaceId, bytes32 indexed contextId, ContextRecord record
    );
    event ContextSuperseded(
        address indexed owner, bytes32 indexed lineageId, bytes32 indexed contextId, bytes32 parentId, uint32 version
    );
    event EvidenceRegistered(
        address indexed owner, bytes32 indexed namespaceId, bytes32 indexed contextId, bytes32 author, bytes32 manifestHash
    );

    constructor(ICapabilityRegistry capabilityRegistry) {
        if (address(capabilityRegistry) == address(0)) revert ZeroRegistry();
        CAPABILITY_REGISTRY = capabilityRegistry;
    }

    /// @notice Registers a batch atomically. msg.sender is either the owner (author = bytes32(0)) or the
    ///         current signer of a registered agent (author = agentId) acting under that owner's capabilities.
    function register(address owner, ContextInput[] calldata inputs) external returns (bytes32[] memory contextIds) {
        if (inputs.length == 0) revert EmptyBatch();
        bytes32 author = _resolveAuthor(owner);
        contextIds = new bytes32[](inputs.length);
        for (uint256 i = 0; i < inputs.length; i++) {
            contextIds[i] = _registerOne(owner, author, inputs[i]);
        }
    }

    function getRecord(bytes32 contextId) external view returns (ContextRecord memory record) {
        record = _records[contextId];
        if (record.owner == address(0)) revert ContextNotFound(contextId);
    }

    function exists(bytes32 contextId) external view returns (bool) {
        return _records[contextId].owner != address(0);
    }

    /// @notice Canonical head of a context lineage; bytes32(0) for unknown lineages and for evidence ids.
    function latest(bytes32 lineageId) external view returns (bytes32) {
        return _latest[lineageId];
    }

    function _resolveAuthor(address owner) private view returns (bytes32 author) {
        if (owner == address(0)) revert CapabilityDenied();
        if (msg.sender == owner) return bytes32(0);
        author = CAPABILITY_REGISTRY.agentIdOfSigner(msg.sender);
        if (author == bytes32(0)) revert CapabilityDenied();
    }

    function _registerOne(address owner, bytes32 author, ContextInput calldata input) private returns (bytes32 contextId) {
        _validateShape(input);
        if (!CAPABILITY_REGISTRY.isRegisteredNamespace(input.namespaceId)) revert InvalidNamespace(input.namespaceId);

        contextId = MidaHashing.contextId(block.chainid, address(this), owner, author, input.namespaceId, input.objectNonce);
        if (input.contextId != contextId) revert ContextIdMismatch(contextId, input.contextId);
        if (_records[contextId].owner != address(0)) revert DuplicateContext(contextId);

        uint64 required = CAPABILITY_REGISTRY.requiredReadEpoch(owner, input.namespaceId);
        if (input.readEpoch != required) revert EpochStale(input.namespaceId, input.readEpoch, required);
        if (!CAPABILITY_REGISTRY.isWriteEpochValid(owner, input.namespaceId, required)) {
            revert EpochRotationRequired(input.namespaceId, required);
        }

        if (input.recordType == RECORD_EVIDENCE) {
            if (author != bytes32(0)) _requireAgentAuthority(owner, author, input.namespaceId, PERM_CREATE, 0);
            _store(owner, author, input, contextId, bytes32(0), bytes32(0), 1);
            emit EvidenceRegistered(owner, input.namespaceId, contextId, author, input.manifestHash);
            return contextId;
        }

        uint8 provenanceBits = _provenanceBits(author == bytes32(0), input);
        if (input.expectedParentId == bytes32(0)) {
            _registerRoot(owner, author, input, contextId, provenanceBits);
        } else {
            _supersede(owner, author, input, contextId, provenanceBits);
        }
    }

    /// @dev Enum ranges, non-zero commitments, and the evidence/context split of spec §11.7.
    function _validateShape(ContextInput calldata input) private pure {
        if (
            input.recordType > RECORD_EVIDENCE || input.lineagePolicy > LINEAGE_OWNER_CONTROLLED || input.kind > KIND_MAX
                || input.provenanceSource > SOURCE_EXTERNAL_ATTESTATION || input.manifestHash == bytes32(0)
                || input.ciphertextCommitment == bytes32(0)
        ) revert InvalidRecord(input.contextId);
        if (input.recordType == RECORD_EVIDENCE) {
            if (
                input.expectedParentId != bytes32(0) || input.lineagePolicy != LINEAGE_STANDARD || input.kind != KIND_NONE
                    || input.provenanceSource != SOURCE_NONE
            ) revert InvalidRecord(input.contextId);
        } else if (input.recordType == RECORD_CONTEXT) {
            if (input.kind == KIND_NONE || input.provenanceSource == SOURCE_NONE) revert InvalidRecord(input.contextId);
        }
    }

    /// @dev Spec §11.8. Returns the provenance-policy bits an agent's capability must carry.
    function _provenanceBits(bool ownerAuthored, ContextInput calldata input) private pure returns (uint8) {
        uint8 source = input.provenanceSource;
        bool hasEvidence = input.evidenceCommitment != bytes32(0);
        if (source == SOURCE_USER_ASSERTED) {
            if (!ownerAuthored) revert ProvenanceForbidden();
            return 0;
        }
        if (source == SOURCE_USER_CONFIRMED) {
            if (!ownerAuthored || !hasEvidence) revert ProvenanceForbidden();
            return 0;
        }
        if (source == SOURCE_AGENT_INFERRED) {
            if (ownerAuthored) revert ProvenanceForbidden();
            return PROV_ALLOW_INFERENCE;
        }
        if (!hasEvidence) revert ProvenanceForbidden();
        if (ownerAuthored) return 0;
        return source == SOURCE_IMPORTED ? PROV_ALLOW_IMPORTED : PROV_ALLOW_EXTERNAL_ATTESTATION;
    }

    function _registerRoot(address owner, bytes32 author, ContextInput calldata input, bytes32 contextId, uint8 provenanceBits)
        private
    {
        if (author != bytes32(0)) {
            if (input.lineagePolicy != LINEAGE_STANDARD) revert AnchorOwnerOnly();
            _requireAgentAuthority(owner, author, input.namespaceId, PERM_CREATE, provenanceBits);
        }
        _store(owner, author, input, contextId, contextId, bytes32(0), 1);
        _latest[contextId] = contextId;
    }

    /// @dev Spec §11.6. The parent must be the current head of a context lineage with the same owner and
    ///      namespace. Agents need SUPERSEDE_OWN on their own lineage or SUPERSEDE_ANY on another author's
    ///      STANDARD lineage; no agent may supersede an OWNER_CONTROLLED lineage.
    function _supersede(address owner, bytes32 author, ContextInput calldata input, bytes32 contextId, uint8 provenanceBits)
        private
    {
        bytes32 parentId = input.expectedParentId;
        ContextRecord storage parent = _records[parentId];
        if (parent.owner == address(0)) revert ContextNotFound(parentId);
        if (parent.recordType == RECORD_EVIDENCE) revert EvidenceImmutable(parentId);
        if (parent.owner != owner || parent.namespaceId != input.namespaceId) revert ParentMismatch(parentId);

        bytes32 lineageId = parent.lineageId;
        bytes32 head = _latest[lineageId];
        if (head != parentId) revert StaleParent(parentId, head);

        ContextRecord storage root = _records[lineageId];
        // Owner-controlled status is fixed at the root and can never be added or removed later.
        if (input.lineagePolicy != root.lineagePolicy) revert InvalidRecord(input.contextId);
        if (author != bytes32(0)) {
            if (root.lineagePolicy == LINEAGE_OWNER_CONTROLLED) revert AnchorOwnerOnly();
            _requireSupersedeAuthority(owner, author, input.namespaceId, root.author == author, provenanceBits);
        }

        uint32 version = parent.version + 1;
        _store(owner, author, input, contextId, lineageId, parentId, version);
        _latest[lineageId] = contextId;
        emit ContextSuperseded(owner, lineageId, contextId, parentId, version);
    }

    function _requireSupersedeAuthority(
        address owner,
        bytes32 agentId,
        bytes32 namespaceId,
        bool ownLineage,
        uint8 provenanceBits
    ) private view {
        bool viaOwn = ownLineage && CAPABILITY_REGISTRY.hasAuthority(owner, agentId, namespaceId, PERM_SUPERSEDE_OWN, 0);
        bool viaAny = CAPABILITY_REGISTRY.hasAuthority(owner, agentId, namespaceId, PERM_SUPERSEDE_ANY, 0);
        if (!viaOwn && !viaAny) revert CapabilityDenied();
        if (provenanceBits == 0) return;
        bool bitsViaOwn =
            ownLineage && CAPABILITY_REGISTRY.hasAuthority(owner, agentId, namespaceId, PERM_SUPERSEDE_OWN, provenanceBits);
        bool bitsViaAny = CAPABILITY_REGISTRY.hasAuthority(owner, agentId, namespaceId, PERM_SUPERSEDE_ANY, provenanceBits);
        if (!bitsViaOwn && !bitsViaAny) revert ProvenanceForbidden();
    }

    /// @dev One exact capability must carry the permission; if provenance bits are required, the same
    ///      capability must carry them too (CapabilityRegistry.hasAuthority checks both together).
    function _requireAgentAuthority(address owner, bytes32 agentId, bytes32 namespaceId, uint8 permission, uint8 provenanceBits)
        private
        view
    {
        if (!CAPABILITY_REGISTRY.hasAuthority(owner, agentId, namespaceId, permission, 0)) revert CapabilityDenied();
        if (provenanceBits != 0 && !CAPABILITY_REGISTRY.hasAuthority(owner, agentId, namespaceId, permission, provenanceBits)) {
            revert ProvenanceForbidden();
        }
    }

    function _store(
        address owner,
        bytes32 author,
        ContextInput calldata input,
        bytes32 contextId,
        bytes32 lineageId,
        bytes32 parentId,
        uint32 version
    ) private {
        ContextRecord memory record = ContextRecord({
            contextId: contextId,
            owner: owner,
            author: author,
            namespaceId: input.namespaceId,
            lineageId: lineageId,
            parentId: parentId,
            manifestHash: input.manifestHash,
            ciphertextCommitment: input.ciphertextCommitment,
            evidenceCommitment: input.evidenceCommitment,
            readEpoch: input.readEpoch,
            createdAt: uint64(block.timestamp),
            expiresAt: input.expiresAt,
            version: version,
            recordType: input.recordType,
            lineagePolicy: input.lineagePolicy,
            kind: input.kind,
            provenanceSource: input.provenanceSource
        });
        _records[contextId] = record;
        emit ContextRegistered(owner, input.namespaceId, contextId, record);
    }
}
