// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {
    KIND_MAX, KIND_NONE, PERM_CREATE, PERM_SUPERSEDE_ANY, PERM_SUPERSEDE_OWN, PROV_ALLOW_INFERENCE,
    SOURCE_AGENT_INFERRED
} from "./MidaTypes.sol";
import {ICapabilityRegistry} from "./ICapabilityRegistry.sol";
import {MidaHashing} from "./MidaHashing.sol";
import {SignatureRecovery} from "./SignatureRecovery.sol";
import {BatchMerkle} from "./BatchMerkle.sol";

/// @notice Checked, Merkle-batched anchoring for automatic checkpoint saves (spec 2026-09-24 + Amendment A).
///         Every save is signed by its agent and checked like ContextRegistry checks a write: signer, shape,
///         area, read epoch, live authority, lineage. Accepted saves share one root the contract computes
///         itself, so a valid proof means "accepted". Reads CapabilityRegistry; never writes it.
contract BatchAnchor {
    struct SignedSave {
        address owner;
        bytes32 namespaceId;
        bytes32 objectNonce;
        bytes32 lineageId;
        bytes32 parentId;
        uint32 parentVersion;
        bytes32 rootAuthor;
        bytes32 manifestHash;
        bytes32 ciphertextCommitment;
        uint64 readEpoch;
        uint64 expiresAt;
        uint8 kind;
        uint8 provenanceSource;
        bytes signature;
    }

    struct Batch {
        bytes32 root;
        uint64 blockNumber;
        uint32 acceptedCount;
    }

    uint8 internal constant BAD_SIGNER = 1;
    uint8 internal constant BAD_SHAPE = 2;
    uint8 internal constant BAD_AREA = 3;
    uint8 internal constant BAD_EPOCH = 4;
    uint8 internal constant NO_AUTHORITY = 5;
    uint8 internal constant ALREADY_ANCHORED = 6;
    uint8 internal constant STALE_PARENT = 7;

    uint256 public constant MAX_BATCH = 1024;
    string internal constant DOMAIN_NAME = "Mida Batch Anchor";
    bytes32 internal constant BATCH_SAVE_TYPEHASH = keccak256(
        "MidaBatchSaveV1(address owner,bytes32 namespaceId,bytes32 objectNonce,bytes32 lineageId,bytes32 parentId,uint32 parentVersion,bytes32 rootAuthor,bytes32 manifestHash,bytes32 ciphertextCommitment,uint64 readEpoch,uint64 expiresAt,uint8 kind,uint8 provenanceSource)"
    );

    error ZeroRegistry();
    error EmptyBatch();
    error BatchTooLarge(uint256 size);
    error BatchExists(bytes32 batchId);

    event SaveAnchored(
        address indexed owner,
        bytes32 indexed contextId,
        bytes32 indexed batchId,
        bytes32 namespaceId,
        bytes32 lineageId,
        uint32 version,
        bytes32 author,
        uint32 position,
        bytes32 leafHash
    );
    event SaveRejected(bytes32 indexed batchId, uint32 index, uint8 reason);
    event BatchAnchored(bytes32 indexed batchId, bytes32 root, uint32 acceptedCount, uint32 rejectedCount, address submitter);

    ICapabilityRegistry public immutable CAPABILITY_REGISTRY;
    bytes32 internal immutable DOMAIN_SEPARATOR;

    mapping(bytes32 lineageId => bytes32) private _headCommit;
    mapping(bytes32 batchId => Batch) private _batches;
    mapping(address owner => bool) public hasBatchedSaves;

    constructor(ICapabilityRegistry capabilityRegistry) {
        if (address(capabilityRegistry) == address(0)) revert ZeroRegistry();
        CAPABILITY_REGISTRY = capabilityRegistry;
        DOMAIN_SEPARATOR = MidaHashing.domainSeparator(DOMAIN_NAME, block.chainid, address(this));
    }

    function batchOf(bytes32 batchId) external view returns (bytes32 root, uint64 blockNumber, uint32 acceptedCount) {
        Batch storage b = _batches[batchId];
        return (b.root, b.blockNumber, b.acceptedCount);
    }

    function headCommitOf(bytes32 lineageId) external view returns (bytes32) {
        return _headCommit[lineageId];
    }

    function submitBatch(bytes32 batchId, SignedSave[] calldata saves) external returns (bytes32 root, uint32 acceptedCount) {
        if (saves.length == 0) revert EmptyBatch();
        if (saves.length > MAX_BATCH) revert BatchTooLarge(saves.length);
        if (_batches[batchId].blockNumber != 0) revert BatchExists(batchId);

        bytes32[] memory accepted = new bytes32[](saves.length);
        uint32 rejected = 0;
        for (uint256 i = 0; i < saves.length; i++) {
            (uint8 reason, bytes32 leaf) = _checkAndApply(batchId, acceptedCount, saves[i]);
            if (reason != 0) {
                emit SaveRejected(batchId, uint32(i), reason);
                rejected++;
            } else {
                accepted[acceptedCount] = leaf;
                acceptedCount++;
            }
        }
        root = BatchMerkle.root(accepted, acceptedCount);
        _batches[batchId] = Batch({root: root, blockNumber: uint64(block.number), acceptedCount: acceptedCount});
        emit BatchAnchored(batchId, root, acceptedCount, rejected, msg.sender);
    }

    /// @dev Returns (0, leaf) on accept after writing state; (reason, 0) on reject with no state written.
    function _checkAndApply(bytes32 batchId, uint32 position, SignedSave calldata s) private returns (uint8, bytes32) {
        bytes32 structHash = _structHash(s);
        address signer = SignatureRecovery.recover(MidaHashing.typedDigest(DOMAIN_SEPARATOR, structHash), s.signature);
        if (signer == address(0)) return (BAD_SIGNER, 0);
        bytes32 agentId = CAPABILITY_REGISTRY.agentIdOfSigner(signer);
        if (agentId == bytes32(0)) return (BAD_SIGNER, 0);

        if (
            s.owner == address(0) || s.kind == KIND_NONE || s.kind > KIND_MAX || s.provenanceSource != SOURCE_AGENT_INFERRED
                || s.manifestHash == bytes32(0) || s.ciphertextCommitment == bytes32(0)
        ) return (BAD_SHAPE, 0);
        if (!CAPABILITY_REGISTRY.isRegisteredNamespace(s.namespaceId)) return (BAD_AREA, 0);

        uint64 required = CAPABILITY_REGISTRY.requiredReadEpoch(s.owner, s.namespaceId);
        if (s.readEpoch != required || !CAPABILITY_REGISTRY.isWriteEpochValid(s.owner, s.namespaceId, required)) {
            return (BAD_EPOCH, 0);
        }

        bytes32 contextId = keccak256(
            abi.encode(
                string("MIDA_BATCH_CONTEXT_V1"), block.chainid, address(this), s.owner, agentId, s.namespaceId, s.parentId,
                s.objectNonce
            )
        );

        bytes32 lineageId;
        bytes32 rootAuthor;
        uint32 version;
        if (s.parentId == bytes32(0)) {
            if (s.lineageId != bytes32(0) || s.parentVersion != 0 || s.rootAuthor != bytes32(0)) return (BAD_SHAPE, 0);
            if (!CAPABILITY_REGISTRY.hasAuthority(s.owner, agentId, s.namespaceId, PERM_CREATE, PROV_ALLOW_INFERENCE)) {
                return (NO_AUTHORITY, 0);
            }
            lineageId = contextId;
            rootAuthor = agentId;
            version = 1;
            if (_headCommit[lineageId] != bytes32(0)) return (ALREADY_ANCHORED, 0);
        } else {
            lineageId = s.lineageId;
            rootAuthor = s.rootAuthor;
            if (s.parentVersion == 0 || s.parentVersion == type(uint32).max) return (BAD_SHAPE, 0);
            bytes32 expected = keccak256(abi.encode(s.parentId, s.owner, s.namespaceId, rootAuthor, s.parentVersion));
            if (_headCommit[lineageId] != expected) return (STALE_PARENT, 0);
            bool allowed = rootAuthor == agentId
                && CAPABILITY_REGISTRY.hasAuthority(s.owner, agentId, s.namespaceId, PERM_SUPERSEDE_OWN, PROV_ALLOW_INFERENCE);
            if (!allowed) {
                allowed =
                    CAPABILITY_REGISTRY.hasAuthority(s.owner, agentId, s.namespaceId, PERM_SUPERSEDE_ANY, PROV_ALLOW_INFERENCE);
            }
            if (!allowed) return (NO_AUTHORITY, 0);
            version = s.parentVersion + 1;
        }

        _headCommit[lineageId] = keccak256(abi.encode(contextId, s.owner, s.namespaceId, rootAuthor, version));
        if (!hasBatchedSaves[s.owner]) hasBatchedSaves[s.owner] = true;
        bytes32 leaf = keccak256(abi.encode(string("MIDA_BATCH_LEAF_V1"), contextId, agentId, lineageId, version, structHash));
        emit SaveAnchored(s.owner, contextId, batchId, s.namespaceId, lineageId, version, agentId, position, leaf);
        return (0, leaf);
    }

    function _structHash(SignedSave calldata s) private pure returns (bytes32) {
        return keccak256(
            abi.encode(
                BATCH_SAVE_TYPEHASH, s.owner, s.namespaceId, s.objectNonce, s.lineageId, s.parentId, s.parentVersion,
                s.rootAuthor, s.manifestHash, s.ciphertextCommitment, s.readEpoch, s.expiresAt, s.kind, s.provenanceSource
            )
        );
    }
}
