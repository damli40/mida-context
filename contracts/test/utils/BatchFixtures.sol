// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {SOURCE_AGENT_INFERRED} from "../../src/MidaTypes.sol";
import {BatchAnchor} from "../../src/BatchAnchor.sol";
import {ICapabilityRegistry} from "../../src/ICapabilityRegistry.sol";
import {MidaHashing} from "../../src/MidaHashing.sol";
import {ContextFixtures} from "./ContextFixtures.sol";

abstract contract BatchFixtures is ContextFixtures {
    BatchAnchor internal anchor;
    uint8 internal constant EPISODE = 5;
    bytes32 internal constant TYPEHASH = keccak256(
        "MidaBatchSaveV1(address owner,bytes32 namespaceId,bytes32 objectNonce,bytes32 lineageId,bytes32 parentId,uint32 parentVersion,bytes32 rootAuthor,bytes32 manifestHash,bytes32 ciphertextCommitment,uint64 readEpoch,uint64 expiresAt,uint8 kind,uint8 provenanceSource)"
    );

    function _deployAnchor() internal {
        _deployContexts();
        anchor = new BatchAnchor(ICapabilityRegistry(address(registry)));
    }

    function _structHash(BatchAnchor.SignedSave memory s) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                TYPEHASH, s.owner, s.namespaceId, s.objectNonce, s.lineageId, s.parentId, s.parentVersion, s.rootAuthor,
                s.manifestHash, s.ciphertextCommitment, s.readEpoch, s.expiresAt, s.kind, s.provenanceSource
            )
        );
    }

    function _signSave(BatchAnchor.SignedSave memory s, uint256 key) internal view returns (BatchAnchor.SignedSave memory) {
        bytes32 digest = MidaHashing.typedDigest(
            MidaHashing.domainSeparator("Mida Batch Anchor", block.chainid, address(anchor)), _structHash(s)
        );
        s.signature = _sign(key, digest);
        return s;
    }

    function _unsignedRoot(address owner, bytes32 namespaceId, string memory nonceLabel)
        internal
        view
        returns (BatchAnchor.SignedSave memory s)
    {
        s.owner = owner;
        s.namespaceId = namespaceId;
        s.objectNonce = keccak256(bytes(nonceLabel));
        s.manifestHash = keccak256(abi.encode(nonceLabel, "manifest"));
        s.ciphertextCommitment = sha256(abi.encode(nonceLabel, "ciphertext"));
        s.readEpoch = registry.requiredReadEpoch(owner, namespaceId);
        s.kind = EPISODE;
        s.provenanceSource = SOURCE_AGENT_INFERRED;
    }

    function _rootSave(address owner, string memory namespaceName, string memory nonceLabel, uint256 key)
        internal
        view
        returns (BatchAnchor.SignedSave memory)
    {
        return _signSave(_unsignedRoot(owner, _ns(namespaceName), nonceLabel), key);
    }

    function _contextIdOf(BatchAnchor.SignedSave memory s, bytes32 agentId) internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                string("MIDA_BATCH_CONTEXT_V1"), block.chainid, address(anchor), s.owner, agentId, s.namespaceId, s.parentId,
                s.objectNonce
            )
        );
    }

    function _childOf(
        BatchAnchor.SignedSave memory parent,
        bytes32 parentAgentId,
        uint32 parentVersion,
        bytes32 lineageId,
        bytes32 rootAuthor,
        string memory nonceLabel,
        uint256 key
    ) internal view returns (BatchAnchor.SignedSave memory s) {
        s = _unsignedRoot(parent.owner, parent.namespaceId, nonceLabel);
        s.parentId = _contextIdOf(parent, parentAgentId);
        s.lineageId = lineageId;
        s.parentVersion = parentVersion;
        s.rootAuthor = rootAuthor;
        return _signSave(s, key);
    }

    function _oneSave(BatchAnchor.SignedSave memory s) internal pure returns (BatchAnchor.SignedSave[] memory list) {
        list = new BatchAnchor.SignedSave[](1);
        list[0] = s;
    }
}
