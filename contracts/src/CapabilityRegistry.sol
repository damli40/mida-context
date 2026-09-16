// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Grants} from "./Grants.sol";
import {MidaWebAuthn} from "./MidaWebAuthn.sol";

/// @notice Canonical authority for Mida Context (spec §10). Task 17 stage: owner keys and grants.
contract CapabilityRegistry is Grants {
    constructor(string memory vaultRpId) MidaWebAuthn(vaultRpId) {}
}
