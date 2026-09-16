// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {MAX_ACTIVE_PER_AGENT, MAX_ACTIVE_PER_NAMESPACE} from "./MidaTypes.sol";

/// @notice Exact capability storage (spec §10.3) with bounded active-capability lists (spec §10.4 rule 8).
abstract contract CapabilityStore {
    struct Capability {
        address owner;
        bytes32 agentId;
        bytes32 namespaceId;
        uint8 permissions;
        uint8 provenancePolicy;
        uint64 issuedAt;
        uint64 expiresAt;
        uint64 agentEpoch;
        uint64 grantedAtReadEpoch;
        bool revoked;
    }

    error CapabilityNotFound(bytes32 capabilityId);
    error CapabilityLimit(bytes32 namespaceId);

    mapping(bytes32 capabilityId => Capability) internal _capabilities;
    mapping(address owner => mapping(bytes32 agentId => uint64)) internal _agentEpoch;
    mapping(address owner => mapping(bytes32 namespaceId => bytes32[])) internal _activeByNamespace;
    mapping(address owner => mapping(bytes32 agentId => bytes32[])) internal _activeByAgent;

    function getCapability(bytes32 capabilityId) external view returns (Capability memory capability) {
        capability = _capabilities[capabilityId];
        if (capability.owner == address(0)) revert CapabilityNotFound(capabilityId);
    }

    function agentEpoch(address owner, bytes32 agentId) external view returns (uint64) {
        return _agentEpoch[owner][agentId];
    }

    /// @notice Valid = exists, not revoked, not expired (block.timestamp < expiresAt when finite),
    ///         and captured agent epoch equals the current owner-agent epoch (spec §10.3).
    function isCapabilityValid(bytes32 capabilityId) public view returns (bool) {
        return _isLive(_capabilities[capabilityId]);
    }

    function activeCapabilityIds(address owner, bytes32 agentId) external view returns (bytes32[] memory) {
        return _activeByAgent[owner][agentId];
    }

    function _isLive(Capability storage capability) internal view returns (bool) {
        return capability.owner != address(0) && !capability.revoked
            && (capability.expiresAt == 0 || block.timestamp < capability.expiresAt)
            && capability.agentEpoch == _agentEpoch[capability.owner][capability.agentId];
    }

    /// @dev Removes revoked, expired and epoch-invalidated entries. Order is not preserved.
    function _compact(bytes32[] storage ids) internal {
        uint256 i;
        while (i < ids.length) {
            if (_isLive(_capabilities[ids[i]])) {
                i++;
            } else {
                ids[i] = ids[ids.length - 1];
                ids.pop();
            }
        }
    }

    function _storeCapability(bytes32 capabilityId, Capability memory capability) internal {
        bytes32[] storage byNamespace = _activeByNamespace[capability.owner][capability.namespaceId];
        bytes32[] storage byAgent = _activeByAgent[capability.owner][capability.agentId];
        _compact(byNamespace);
        _compact(byAgent);
        if (byNamespace.length >= MAX_ACTIVE_PER_NAMESPACE || byAgent.length >= MAX_ACTIVE_PER_AGENT) {
            revert CapabilityLimit(capability.namespaceId);
        }
        _capabilities[capabilityId] = capability;
        byNamespace.push(capabilityId);
        byAgent.push(capabilityId);
    }
}
