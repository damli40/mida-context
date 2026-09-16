// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {WebAuthn} from "webauthn-sol/WebAuthn.sol";
import {MidaWebAuthn} from "../src/MidaWebAuthn.sol";
import {WebAuthnSigner} from "./utils/WebAuthnSigner.sol";

contract WebAuthnHarness is MidaWebAuthn {
    constructor(string memory rpId) MidaWebAuthn(rpId) {}

    function verify(bytes32 challenge, WebAuthn.WebAuthnAuth memory auth, uint256 qx, uint256 qy)
        external
        view
        returns (bool)
    {
        return _verifyVaultAssertion(challenge, auth, qx, qy);
    }
}

/// @notice §15 WebAuthn rows. Fixture assertions come from ox (export-webauthn-fixture.ts);
///         the rest are built with WebAuthnSigner, which the byte-layout test proves compatible.
contract MidaWebAuthnTest is Test {
    uint256 internal constant OWNER_P256_KEY = 0xa11ce;
    bytes32 internal constant CHALLENGE = keccak256("grant digest under test");

    WebAuthnHarness internal harness;
    string internal fixture;

    function setUp() public {
        harness = new WebAuthnHarness(WebAuthnSigner.VAULT_RP_ID);
        fixture = vm.readFile("test/vectors/webauthn-v1.json");
    }

    function _fixtureAuth() internal view returns (WebAuthn.WebAuthnAuth memory) {
        return WebAuthn.WebAuthnAuth({
            authenticatorData: vm.parseJsonBytes(fixture, ".authenticatorData"),
            clientDataJSON: vm.parseJsonString(fixture, ".clientDataJSON"),
            challengeIndex: vm.parseJsonUint(fixture, ".challengeIndex"),
            typeIndex: vm.parseJsonUint(fixture, ".typeIndex"),
            r: uint256(vm.parseJsonBytes32(fixture, ".r")),
            s: uint256(vm.parseJsonBytes32(fixture, ".s"))
        });
    }

    function _fixtureKey() internal view returns (uint256 qx, uint256 qy) {
        return (uint256(vm.parseJsonBytes32(fixture, ".qx")), uint256(vm.parseJsonBytes32(fixture, ".qy")));
    }

    function test_rpIdHashIsSha256OfConfiguredRpId() public view {
        assertEq(harness.VAULT_RP_ID_HASH(), sha256("vault.mida.xyz"));
        assertEq(harness.vaultRpId(), "vault.mida.xyz");
    }

    function test_emptyRpIdRejectedAtDeployment() public {
        vm.expectRevert(MidaWebAuthn.EmptyRpId.selector);
        new WebAuthnHarness("");
    }

    function test_oxFixtureVerifies() public view {
        (uint256 qx, uint256 qy) = _fixtureKey();
        assertTrue(harness.verify(vm.parseJsonBytes32(fixture, ".challenge"), _fixtureAuth(), qx, qy));
    }

    function test_soliditySignerMatchesOxByteLayout() public view {
        bytes32 challenge = vm.parseJsonBytes32(fixture, ".challenge");
        assertEq(
            WebAuthnSigner.clientDataJSON(challenge, WebAuthnSigner.VAULT_ORIGIN),
            vm.parseJsonString(fixture, ".clientDataJSON")
        );
        assertEq(
            WebAuthnSigner.authenticatorData(WebAuthnSigner.VAULT_RP_ID, WebAuthnSigner.FLAGS_UP_UV),
            vm.parseJsonBytes(fixture, ".authenticatorData")
        );
    }

    function test_soliditySignerAssertionVerifies() public view {
        (uint256 qx, uint256 qy) = WebAuthnSigner.publicKey(OWNER_P256_KEY);
        assertTrue(harness.verify(CHALLENGE, WebAuthnSigner.sign(OWNER_P256_KEY, CHALLENGE), qx, qy));
    }

    function test_wrongChallengeRejected() public view {
        (uint256 qx, uint256 qy) = WebAuthnSigner.publicKey(OWNER_P256_KEY);
        assertFalse(harness.verify(keccak256("other"), WebAuthnSigner.sign(OWNER_P256_KEY, CHALLENGE), qx, qy));
    }

    function test_wrongKeyRejected() public view {
        (uint256 qx, uint256 qy) = WebAuthnSigner.publicKey(OWNER_P256_KEY + 1);
        assertFalse(harness.verify(CHALLENGE, WebAuthnSigner.sign(OWNER_P256_KEY, CHALLENGE), qx, qy));
    }

    /// @dev §15 "grant signed without user-verification flag".
    function test_missingUserVerificationRejected() public view {
        (uint256 qx, uint256 qy) = WebAuthnSigner.publicKey(OWNER_P256_KEY);
        WebAuthn.WebAuthnAuth memory auth = WebAuthnSigner.signWith(
            OWNER_P256_KEY, CHALLENGE, WebAuthnSigner.VAULT_RP_ID, WebAuthnSigner.VAULT_ORIGIN, WebAuthnSigner.FLAGS_UP_ONLY
        );
        assertFalse(harness.verify(CHALLENGE, auth, qx, qy));
    }

    /// @dev §15 "authenticatorData[0:32] is not the configured Vault RP-ID hash": rejected by the wrapper.
    function test_foreignRpIdRejectedByWrapper() public view {
        (uint256 qx, uint256 qy) = WebAuthnSigner.publicKey(OWNER_P256_KEY);
        WebAuthn.WebAuthnAuth memory auth = WebAuthnSigner.signWith(
            OWNER_P256_KEY, CHALLENGE, "evil.example", "https://vault.mida.xyz", WebAuthnSigner.FLAGS_UP_UV
        );
        assertTrue(WebAuthn.verify(abi.encode(CHALLENGE), true, auth, qx, qy), "library alone accepts it");
        assertFalse(harness.verify(CHALLENGE, auth, qx, qy), "Mida wrapper must reject it");
    }

    /// @dev §15 "high-s signature": rejected by webauthn-sol.
    function test_highSRejected() public view {
        (uint256 qx, uint256 qy) = WebAuthnSigner.publicKey(OWNER_P256_KEY);
        WebAuthn.WebAuthnAuth memory auth = WebAuthnSigner.sign(OWNER_P256_KEY, CHALLENGE);
        auth.s = WebAuthnSigner.P256_N - auth.s;
        assertFalse(harness.verify(CHALLENGE, auth, qx, qy));
    }

    /// @dev §15 "foreign clientDataJSON.origin but correct RP-ID hash": ACCEPTED on-chain.
    ///      This test documents the v0 limitation; if it ever fails, update spec §10.4 first.
    function test_foreignOriginWithCorrectRpIdIsAcceptedOnChain() public view {
        (uint256 qx, uint256 qy) = WebAuthnSigner.publicKey(OWNER_P256_KEY);
        WebAuthn.WebAuthnAuth memory auth = WebAuthnSigner.signWith(
            OWNER_P256_KEY, CHALLENGE, WebAuthnSigner.VAULT_RP_ID, "https://evil.example", WebAuthnSigner.FLAGS_UP_UV
        );
        assertTrue(harness.verify(CHALLENGE, auth, qx, qy));
    }

    function test_truncatedAuthenticatorDataRejected() public view {
        (uint256 qx, uint256 qy) = WebAuthnSigner.publicKey(OWNER_P256_KEY);
        WebAuthn.WebAuthnAuth memory auth = WebAuthnSigner.sign(OWNER_P256_KEY, CHALLENGE);
        auth.authenticatorData = abi.encodePacked(sha256("vault.mida.xyz"));
        assertFalse(harness.verify(CHALLENGE, auth, qx, qy));
    }
}
