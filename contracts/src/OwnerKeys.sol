// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {WebAuthn} from "webauthn-sol/WebAuthn.sol";
import {MidaHashing} from "./MidaHashing.sol";
import {MidaWebAuthn} from "./MidaWebAuthn.sol";

/// @notice Owner P256 passkey keys (spec §10.1). Registration never overwrites; rotation needs an
///         assertion from the currently registered key over MIDA_ROTATE_P256_V1 with a contract nonce.
abstract contract OwnerKeys is MidaWebAuthn {
    struct P256Key {
        uint256 qx;
        uint256 qy;
    }

    error ZeroP256Key();
    error P256KeyExists(address owner);
    error P256KeyMissing(address owner);
    error WebAuthnInvalid();

    mapping(address owner => P256Key) private _ownerKeys;
    mapping(address owner => uint256) public p256RotationNonce;

    event P256KeyRegistered(address indexed owner, uint256 qx, uint256 qy, uint256 rotationNonce);

    function registerP256Key(uint256 qx, uint256 qy) external {
        if (qx == 0 || qy == 0) revert ZeroP256Key();
        if (_ownerKeys[msg.sender].qx != 0) revert P256KeyExists(msg.sender);
        _ownerKeys[msg.sender] = P256Key(qx, qy);
        emit P256KeyRegistered(msg.sender, qx, qy, 0);
    }

    function rotateP256Key(uint256 newQx, uint256 newQy, WebAuthn.WebAuthnAuth calldata auth) external {
        P256Key memory current = _requireOwnerKey(msg.sender);
        if (newQx == 0 || newQy == 0) revert ZeroP256Key();
        uint256 nonce = p256RotationNonce[msg.sender];
        bytes32 digest = MidaHashing.p256RotationDigest(block.chainid, address(this), msg.sender, newQx, newQy, nonce);
        if (!_verifyVaultAssertion(digest, auth, current.qx, current.qy)) revert WebAuthnInvalid();
        p256RotationNonce[msg.sender] = nonce + 1;
        _ownerKeys[msg.sender] = P256Key(newQx, newQy);
        emit P256KeyRegistered(msg.sender, newQx, newQy, nonce + 1);
    }

    function ownerP256Key(address owner) external view returns (uint256 qx, uint256 qy) {
        P256Key memory key = _ownerKeys[owner];
        return (key.qx, key.qy);
    }

    function _requireOwnerKey(address owner) internal view returns (P256Key memory key) {
        key = _ownerKeys[owner];
        if (key.qx == 0) revert P256KeyMissing(owner);
    }
}
