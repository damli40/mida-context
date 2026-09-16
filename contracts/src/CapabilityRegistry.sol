// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {MidaWebAuthn} from "./MidaWebAuthn.sol";
import {Revocations} from "./Revocations.sol";
import {MIDA_POLICY_DOCUMENT_HASH_V1} from "./generated/PolicyHashV1.sol";

/// @notice Canonical authority for Mida Context (spec §10): namespaces, agents, owner passkey keys,
///         exact capabilities, read epochs with their public keys, and revocation.
contract CapabilityRegistry is Revocations {
    /// @notice keccak256 of the canonical mida-grant-policy-v1 document (spec §14.2).
    bytes32 public constant POLICY_HASH_V1 = MIDA_POLICY_DOCUMENT_HASH_V1;

    constructor(string memory vaultRpId) MidaWebAuthn(vaultRpId) {}
}
