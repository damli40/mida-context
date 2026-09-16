// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {NamespaceTree} from "./NamespaceTree.sol";

/// @notice Read-epoch generations, their immutable public keys, and write deadlines (spec §7.2, §10.6).
///         Keys live here, not in ContextRegistry, so revocation and key publication share one call.
abstract contract ReadEpochs is NamespaceTree {
    error ZeroEpochKey();
    error EpochAlreadyInitialized(bytes32 namespaceId);

    mapping(address owner => mapping(bytes32 namespaceId => uint64)) private _currentEpoch;
    mapping(address owner => mapping(bytes32 namespaceId => mapping(uint64 epoch => bytes32))) private _epochKeys;
    mapping(address owner => mapping(bytes32 namespaceId => uint64)) internal _writeDeadline;

    event ReadEpochRequired(address indexed owner, bytes32 indexed namespaceId, uint64 readEpoch, uint64 writeDeadline);
    event NamespaceEpochKeySet(
        address indexed owner, bytes32 indexed namespaceId, uint64 indexed readEpoch, bytes32 publicKey
    );

    /// @notice Publishes epoch 1 for msg.sender. Published keys are never replaced.
    function initializeReadEpoch(bytes32 namespaceId, bytes32 publicKey) external {
        _requireNamespace(namespaceId);
        if (publicKey == bytes32(0)) revert ZeroEpochKey();
        if (_epochKeys[msg.sender][namespaceId][1] != bytes32(0)) revert EpochAlreadyInitialized(namespaceId);
        _epochKeys[msg.sender][namespaceId][1] = publicKey;
        emit NamespaceEpochKeySet(msg.sender, namespaceId, 1, publicKey);
    }

    /// @notice Defaults to 1 when no epoch has been advanced (spec §10.6).
    function requiredReadEpoch(address owner, bytes32 namespaceId) public view returns (uint64) {
        uint64 epoch = _currentEpoch[owner][namespaceId];
        return epoch == 0 ? 1 : epoch;
    }

    function epochPublicKey(address owner, bytes32 namespaceId, uint64 epoch) public view returns (bytes32) {
        return _epochKeys[owner][namespaceId][epoch];
    }

    function writeDeadline(address owner, bytes32 namespaceId) external view returns (uint64) {
        return _writeDeadline[owner][namespaceId];
    }

    /// @notice Frozen invariant (spec §7.2): writes only while the deadline is strictly in the future.
    function isWriteEpochValid(address owner, bytes32 namespaceId, uint64 epoch) public view returns (bool) {
        uint64 deadline = _writeDeadline[owner][namespaceId];
        return epoch == requiredReadEpoch(owner, namespaceId) && _epochKeys[owner][namespaceId][epoch] != bytes32(0)
            && (deadline == 0 || block.timestamp < deadline);
    }

    function _lowerWriteDeadline(address owner, bytes32 namespaceId, uint64 expiresAt) internal {
        if (expiresAt == 0) return;
        uint64 current = _writeDeadline[owner][namespaceId];
        if (current == 0 || expiresAt < current) _writeDeadline[owner][namespaceId] = expiresAt;
    }

    /// @dev Advances to the next epoch, stores its key and the recomputed deadline. Used by Task 18.
    function _publishNextEpoch(address owner, bytes32 namespaceId, bytes32 publicKey, uint64 newDeadline)
        internal
        returns (uint64 next)
    {
        if (publicKey == bytes32(0)) revert ZeroEpochKey();
        next = requiredReadEpoch(owner, namespaceId) + 1;
        _currentEpoch[owner][namespaceId] = next;
        _epochKeys[owner][namespaceId][next] = publicKey;
        _writeDeadline[owner][namespaceId] = newDeadline;
        emit ReadEpochRequired(owner, namespaceId, next, newDeadline);
        emit NamespaceEpochKeySet(owner, namespaceId, next, publicKey);
    }
}
