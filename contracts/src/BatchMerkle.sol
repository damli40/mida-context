// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Commutative Merkle tree, identical to packages/protocol/src/batch.ts: pair = keccak256(min || max),
///         an odd last node is carried up unchanged, the root of one leaf is the leaf, of none is zero.
library BatchMerkle {
    function hashPair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    /// @dev Overwrites `nodes` in place.
    function root(bytes32[] memory nodes, uint256 count) internal pure returns (bytes32) {
        if (count == 0) return bytes32(0);
        while (count > 1) {
            uint256 next = 0;
            for (uint256 i = 0; i < count; i += 2) {
                nodes[next] = i + 1 < count ? hashPair(nodes[i], nodes[i + 1]) : nodes[i];
                next++;
            }
            count = next;
        }
        return nodes[0];
    }

    function verify(bytes32 leaf, bytes32[] memory proof, bytes32 expectedRoot) internal pure returns (bool) {
        bytes32 node = leaf;
        for (uint256 i = 0; i < proof.length; i++) node = hashPair(node, proof[i]);
        return node == expectedRoot;
    }
}
