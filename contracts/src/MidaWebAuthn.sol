// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {WebAuthn} from "webauthn-sol/WebAuthn.sol";

/// @notice Mida's WebAuthn verification boundary (spec §10.4).
///         This wrapper checks the RP-ID hash; webauthn-sol checks type, challenge, UP, UV (always
///         required here), low-s and the P256 signature. clientDataJSON.origin is NOT checked
///         on-chain: that binding rests on the browser refusing to assert this RP ID for another
///         origin. This is a documented v0 limitation.
abstract contract MidaWebAuthn {
    error EmptyRpId();

    /// @notice SHA-256 of the configured Vault RP ID, compared with authenticatorData[0:32].
    bytes32 public immutable VAULT_RP_ID_HASH;
    string public vaultRpId;

    constructor(string memory rpId) {
        if (bytes(rpId).length == 0) revert EmptyRpId();
        VAULT_RP_ID_HASH = sha256(bytes(rpId));
        vaultRpId = rpId;
    }

    /// @param challenge The 32-byte digest the owner approved (grantDigest or p256RotationDigest).
    function _verifyVaultAssertion(bytes32 challenge, WebAuthn.WebAuthnAuth memory auth, uint256 qx, uint256 qy)
        internal
        view
        returns (bool)
    {
        // 32 bytes rpIdHash + 1 byte flags + 4 bytes signCount
        if (auth.authenticatorData.length < 37) return false;
        if (bytes32(auth.authenticatorData) != VAULT_RP_ID_HASH) return false;
        return WebAuthn.verify(abi.encode(challenge), true, auth, qx, qy);
    }
}
