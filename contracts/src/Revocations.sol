// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PERM_READ} from "./MidaTypes.sol";
import {Grants} from "./Grants.sol";

/// @notice Ending authority (spec §7.3, §10.5, §10.6). Any path that ends live READ authority advances the
///         namespace read epoch and publishes the next public key in the same call, so one owner EOA
///         transaction is enough and no cross-contract call changes msg.sender.
abstract contract Revocations is Grants {
    struct EpochRotation {
        bytes32 namespaceId;
        bytes32 newEpochPublicKey;
    }

    error NotCapabilityOwner(bytes32 capabilityId);
    error CapabilityAlreadyRevoked(bytes32 capabilityId);
    error ReadRequiresRotation(bytes32 capabilityId);
    error RotationNotApplicable(bytes32 capabilityId);
    error RotationSetMismatch();
    error EpochNotExpired(bytes32 namespaceId);

    event CapabilityRevoked(
        address indexed owner, bytes32 indexed agentId, bytes32 indexed namespaceId, bytes32 capabilityId
    );
    event AgentRevoked(address indexed owner, bytes32 indexed agentId, uint64 agentEpoch);

    /// @notice Revokes a capability that does not currently confer READ. Live READ must use revokeAndRotate.
    function revoke(bytes32 capabilityId) external {
        Capability storage capability = _ownedUnrevoked(capabilityId);
        if (capability.permissions & PERM_READ != 0 && _isLive(capability)) revert ReadRequiresRotation(capabilityId);
        capability.revoked = true;
        emit CapabilityRevoked(capability.owner, capability.agentId, capability.namespaceId, capabilityId);
    }

    /// @notice Ends one live READ capability and advances its namespace to the next epoch with newEpochPublicKey.
    function revokeAndRotate(bytes32 capabilityId, bytes32 newEpochPublicKey) external {
        Capability storage capability = _ownedUnrevoked(capabilityId);
        if (capability.permissions & PERM_READ == 0 || !_isLive(capability)) revert RotationNotApplicable(capabilityId);
        capability.revoked = true;
        emit CapabilityRevoked(capability.owner, capability.agentId, capability.namespaceId, capabilityId);
        _rotate(msg.sender, capability.namespaceId, newEpochPublicKey);
    }

    /// @notice Invalidates every capability msg.sender granted to agentId by incrementing the owner-agent epoch.
    ///         rotations must name exactly the unique namespaces where the agent held live READ, once each.
    function revokeAgentAndRotate(bytes32 agentId, EpochRotation[] calldata rotations) external {
        bytes32[] storage ids = _activeByAgent[msg.sender][agentId];
        bytes32[] memory readNamespaces = new bytes32[](ids.length);
        uint256 count;
        for (uint256 i = 0; i < ids.length; i++) {
            Capability storage capability = _capabilities[ids[i]];
            if (capability.permissions & PERM_READ == 0 || !_isLive(capability)) continue;
            bool seen;
            for (uint256 j = 0; j < count; j++) {
                if (readNamespaces[j] == capability.namespaceId) {
                    seen = true;
                    break;
                }
            }
            if (!seen) readNamespaces[count++] = capability.namespaceId;
        }

        uint64 newAgentEpoch = _agentEpoch[msg.sender][agentId] + 1;
        _agentEpoch[msg.sender][agentId] = newAgentEpoch;
        delete _activeByAgent[msg.sender][agentId];
        emit AgentRevoked(msg.sender, agentId, newAgentEpoch);

        if (rotations.length != count) revert RotationSetMismatch();
        for (uint256 i = 0; i < rotations.length; i++) {
            bool expected;
            for (uint256 j = 0; j < count; j++) {
                // Namespace ids are never zero, so clearing a matched slot also rejects duplicates.
                if (readNamespaces[j] == rotations[i].namespaceId) {
                    readNamespaces[j] = bytes32(0);
                    expected = true;
                    break;
                }
            }
            if (!expected) revert RotationSetMismatch();
            _rotate(msg.sender, rotations[i].namespaceId, rotations[i].newEpochPublicKey);
        }
    }

    /// @notice Resumes writes after the earliest READ expiry closed the epoch (spec §7.3 expiry).
    function rotateExpiredEpoch(bytes32 namespaceId, bytes32 newEpochPublicKey) external {
        uint64 deadline = _writeDeadline[msg.sender][namespaceId];
        if (deadline == 0 || block.timestamp < deadline) revert EpochNotExpired(namespaceId);
        _rotate(msg.sender, namespaceId, newEpochPublicKey);
    }

    /// @notice Exact authorization (spec §10.5): one registered namespace, one permission bit, no ancestry.
    function isAuthorized(address owner, bytes32 agentId, bytes32 namespaceId, uint8 permission)
        external
        view
        returns (bool)
    {
        return hasAuthority(owner, agentId, namespaceId, permission, 0);
    }

    /// @notice True only if ONE live exact capability carries every requested permission and provenance bit.
    ///         A zero permission never authorizes anything.
    function hasAuthority(address owner, bytes32 agentId, bytes32 namespaceId, uint8 permissions, uint8 provenanceBits)
        public
        view
        returns (bool)
    {
        if (permissions == 0 || !isRegisteredNamespace(namespaceId)) return false;
        bytes32[] storage ids = _activeByAgent[owner][agentId];
        for (uint256 i = 0; i < ids.length; i++) {
            Capability storage capability = _capabilities[ids[i]];
            if (
                capability.namespaceId == namespaceId && _isLive(capability)
                    && capability.permissions & permissions == permissions
                    && capability.provenancePolicy & provenanceBits == provenanceBits
            ) return true;
        }
        return false;
    }

    function _ownedUnrevoked(bytes32 capabilityId) private view returns (Capability storage capability) {
        capability = _capabilities[capabilityId];
        if (capability.owner == address(0)) revert CapabilityNotFound(capabilityId);
        if (capability.owner != msg.sender) revert NotCapabilityOwner(capabilityId);
        if (capability.revoked) revert CapabilityAlreadyRevoked(capabilityId);
    }

    /// @dev Recomputes the next deadline from remaining live exact READ capabilities (at most 32), then
    ///      publishes the next epoch key.
    function _rotate(address owner, bytes32 namespaceId, bytes32 newEpochPublicKey) private {
        bytes32[] storage ids = _activeByNamespace[owner][namespaceId];
        _compact(ids);
        uint64 deadline;
        for (uint256 i = 0; i < ids.length; i++) {
            Capability storage capability = _capabilities[ids[i]];
            if (capability.permissions & PERM_READ == 0 || capability.expiresAt == 0) continue;
            if (deadline == 0 || capability.expiresAt < deadline) deadline = capability.expiresAt;
        }
        _publishNextEpoch(owner, namespaceId, newEpochPublicKey, deadline);
    }
}
