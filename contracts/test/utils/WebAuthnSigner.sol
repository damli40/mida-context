// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {Base64} from "openzeppelin-contracts/contracts/utils/Base64.sol";
import {WebAuthn} from "webauthn-sol/WebAuthn.sol";

/// @notice Builds WebAuthn assertions inside Foundry tests with the signP256 cheatcode, in the exact
///         byte layout ox's WebAuthnP256.getSignPayload produces (checked against webauthn-v1.json
///         in MidaWebAuthn.t.sol). Always emits low-s, as every Mida assertion adapter must.
///         Build assertions BEFORE vm.prank: the sha256 precompile calls inside consume a pending prank.
library WebAuthnSigner {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 internal constant P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551;
    bytes1 internal constant FLAGS_UP_UV = 0x05;
    bytes1 internal constant FLAGS_UP_ONLY = 0x01;
    string internal constant VAULT_RP_ID = "vault.mida.xyz";
    string internal constant VAULT_ORIGIN = "https://vault.mida.xyz";

    function publicKey(uint256 privateKey) internal pure returns (uint256 qx, uint256 qy) {
        return VM.publicKeyP256(privateKey);
    }

    function clientDataJSON(bytes32 challenge, string memory origin) internal pure returns (string memory) {
        return string.concat(
            '{"type":"webauthn.get","challenge":"',
            Base64.encodeURL(abi.encodePacked(challenge)),
            '","origin":"',
            origin,
            '","crossOrigin":false}'
        );
    }

    function authenticatorData(string memory rpId, bytes1 flags) internal pure returns (bytes memory) {
        return abi.encodePacked(sha256(bytes(rpId)), flags, uint32(0));
    }

    function sign(uint256 privateKey, bytes32 challenge) internal pure returns (WebAuthn.WebAuthnAuth memory) {
        return signWith(privateKey, challenge, VAULT_RP_ID, VAULT_ORIGIN, FLAGS_UP_UV);
    }

    function signWith(uint256 privateKey, bytes32 challenge, string memory rpId, string memory origin, bytes1 flags)
        internal
        pure
        returns (WebAuthn.WebAuthnAuth memory auth)
    {
        bytes memory authData = authenticatorData(rpId, flags);
        string memory clientData = clientDataJSON(challenge, origin);
        bytes32 messageHash = sha256(abi.encodePacked(authData, sha256(bytes(clientData))));
        (bytes32 r, bytes32 s) = VM.signP256(privateKey, messageHash);
        uint256 lowS = uint256(s) > P256_N / 2 ? P256_N - uint256(s) : uint256(s);
        auth = WebAuthn.WebAuthnAuth({
            authenticatorData: authData,
            clientDataJSON: clientData,
            challengeIndex: 23,
            typeIndex: 1,
            r: uint256(r),
            s: lowS
        });
    }
}
