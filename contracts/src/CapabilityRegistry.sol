// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AgentRegistry} from "./AgentRegistry.sol";
import {MidaWebAuthn} from "./MidaWebAuthn.sol";
import {NamespaceTree} from "./NamespaceTree.sol";

/// @notice Canonical authority for Mida Context (spec §10). Task 16 stage: namespaces and agents.
contract CapabilityRegistry is NamespaceTree, AgentRegistry, MidaWebAuthn {
    constructor(string memory vaultRpId) MidaWebAuthn(vaultRpId) {}
}
