// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {BatchMerkle} from "../src/BatchMerkle.sol";
import {MidaHashing} from "../src/MidaHashing.sol";

/// @notice The batched-save typehash, struct hash, EIP-712 digest, context id, leaf hash, head commit and
///         Merkle root must equal the TypeScript vectors in test/vectors/batch-v1.json (exported by
///         packages/protocol/scripts/export-vectors.ts). A failure here means the two layers drifted.
contract BatchParityTest is Test {
    string internal vectors;

    bytes32 internal constant TYPEHASH = keccak256(
        "MidaBatchSaveV1(address owner,bytes32 namespaceId,bytes32 objectNonce,bytes32 lineageId,bytes32 parentId,uint32 parentVersion,bytes32 rootAuthor,bytes32 manifestHash,bytes32 ciphertextCommitment,uint64 readEpoch,uint64 expiresAt,uint8 kind,uint8 provenanceSource)"
    );

    function setUp() public {
        vectors = vm.readFile("test/vectors/batch-v1.json");
    }

    function _b32(string memory key) internal view returns (bytes32) {
        return vm.parseJsonBytes32(vectors, string.concat(".", key));
    }

    function _m32(string memory key) internal view returns (bytes32) {
        return vm.parseJsonBytes32(vectors, string.concat(".message.", key));
    }

    function _structHash() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                TYPEHASH,
                vm.parseJsonAddress(vectors, ".message.owner"),
                _m32("namespaceId"),
                _m32("objectNonce"),
                _m32("lineageId"),
                _m32("parentId"),
                uint32(vm.parseJsonUint(vectors, ".message.parentVersion")),
                _m32("rootAuthor"),
                _m32("manifestHash"),
                _m32("ciphertextCommitment"),
                uint64(vm.parseJsonUint(vectors, ".message.readEpoch")),
                uint64(vm.parseJsonUint(vectors, ".message.expiresAt")),
                uint8(vm.parseJsonUint(vectors, ".message.kind")),
                uint8(vm.parseJsonUint(vectors, ".message.provenanceSource"))
            )
        );
    }

    function test_typehash() public view {
        assertEq(TYPEHASH, _b32("typehash"));
    }

    function test_structHash() public view {
        assertEq(_structHash(), _b32("structHash"));
    }

    function test_digest() public view {
        bytes32 separator = MidaHashing.domainSeparator(
            "Mida Batch Anchor", vm.parseJsonUint(vectors, ".chainId"), vm.parseJsonAddress(vectors, ".batchAnchor")
        );
        assertEq(MidaHashing.typedDigest(separator, _structHash()), _b32("digest"));
    }

    function test_contextId() public view {
        bytes32 computed = keccak256(
            abi.encode(
                string("MIDA_BATCH_CONTEXT_V1"),
                vm.parseJsonUint(vectors, ".chainId"),
                vm.parseJsonAddress(vectors, ".batchAnchor"),
                vm.parseJsonAddress(vectors, ".owner"),
                _b32("agentId"),
                _b32("namespaceId"),
                _b32("parentId"),
                _b32("objectNonce")
            )
        );
        assertEq(computed, _b32("contextId"));
    }

    /// @dev The vector is a version-1 root: lineageId = contextId, rootAuthor = agentId.
    function test_leafHash() public view {
        bytes32 leaf = keccak256(
            abi.encode(
                string("MIDA_BATCH_LEAF_V1"), _b32("contextId"), _b32("agentId"), _b32("contextId"), uint32(1),
                _b32("structHash")
            )
        );
        assertEq(leaf, _b32("leafHash"));
    }

    function test_headCommit() public view {
        bytes32 commit = keccak256(
            abi.encode(
                _b32("contextId"), vm.parseJsonAddress(vectors, ".owner"), _b32("namespaceId"), _b32("agentId"),
                uint32(1)
            )
        );
        assertEq(commit, _b32("headCommit"));
    }

    function test_merkleRoot() public view {
        bytes32[] memory leaves = vm.parseJsonBytes32Array(vectors, ".leaves");
        assertEq(leaves.length, 5);
        assertEq(BatchMerkle.root(leaves, 5), _b32("root"));
    }
}
