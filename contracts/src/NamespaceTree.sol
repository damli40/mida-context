// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {InvalidNamespace} from "./MidaTypes.sol";
import {MidaHashing} from "./MidaHashing.sol";

/// @notice Frozen namespace tree v1 (spec §5.2), registered in the constructor in the same order as
///         NAMESPACE_TREE_V1 in the TypeScript protocol package. No registration function exists
///         after deployment, so a parent grant can never silently acquire a future child.
abstract contract NamespaceTree {
    struct NamespaceInfo {
        bool registered;
        bool highSensitivity;
        bytes32 parentId;
    }

    uint256 public constant NAMESPACE_COUNT = 22;

    mapping(bytes32 namespaceId => NamespaceInfo) private _namespaces;

    event NamespaceRegistered(bytes32 indexed namespaceId, bytes32 indexed parentId, string name, bool highSensitivity);

    constructor() {
        _node("profile", "", false);
        _node("profile.identity", "profile", false);
        _node("profile.skills", "profile", false);
        _node("goals", "", false);
        _node("goals.career", "goals", false);
        _node("goals.learning", "goals", false);
        _node("goals.personal", "goals", false);
        _node("preferences", "", false);
        _node("preferences.communication", "preferences", false);
        _node("preferences.tools", "preferences", false);
        _node("preferences.work", "preferences", false);
        _node("projects", "", false);
        _node("projects.current", "projects", false);
        _node("projects.past", "projects", false);
        _node("decisions", "", false);
        _node("decisions.career", "decisions", false);
        _node("decisions.projects", "decisions", false);
        _node("credentials", "", true);
        _node("financial", "", true);
        _node("financial.preferences", "financial", true);
        _node("relationships", "", false);
        _node("private", "", true);
    }

    function isRegisteredNamespace(bytes32 namespaceId) public view returns (bool) {
        return _namespaces[namespaceId].registered;
    }

    function namespaceParent(bytes32 namespaceId) external view returns (bytes32) {
        _requireNamespace(namespaceId);
        return _namespaces[namespaceId].parentId;
    }

    /// @dev HIGH set from spec §14.2: credentials, financial, financial.preferences, private.
    function isHighSensitivity(bytes32 namespaceId) public view returns (bool) {
        _requireNamespace(namespaceId);
        return _namespaces[namespaceId].highSensitivity;
    }

    function _requireNamespace(bytes32 namespaceId) internal view {
        if (!_namespaces[namespaceId].registered) revert InvalidNamespace(namespaceId);
    }

    function _node(string memory name, string memory parent, bool high) private {
        bytes32 id = MidaHashing.namespaceId(name);
        bytes32 parentId = bytes(parent).length == 0 ? bytes32(0) : MidaHashing.namespaceId(parent);
        if (parentId != bytes32(0)) _requireNamespace(parentId);
        _namespaces[id] = NamespaceInfo({registered: true, highSensitivity: high, parentId: parentId});
        emit NamespaceRegistered(id, parentId, name, high);
    }
}
