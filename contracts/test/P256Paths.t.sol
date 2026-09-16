// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {WebAuthn} from "webauthn-sol/WebAuthn.sol";
import {WebAuthnHarness} from "./MidaWebAuthn.t.sol";

/// @notice Evidence that the two local verification paths are distinct (spec §10.4, §19).
///         Run twice:
///           forge test --match-contract P256PathsTest -vv                      -> native PASS, fallback SKIP
///           forge test --match-contract P256PathsTest -vv --evm-version prague -> native SKIP, fallback PASS
///         The Monad testnet native path is evidenced separately in plan Task 27.
contract P256PathsTest is Test {
    uint256 internal constant NATIVE_MAX_GAS = 120_000;
    uint256 internal constant FALLBACK_MIN_GAS = 250_000;

    WebAuthnHarness internal harness;
    string internal fixture;
    WebAuthn.WebAuthnAuth internal auth;
    bytes32 internal challenge;
    uint256 internal qx;
    uint256 internal qy;

    function setUp() public {
        harness = new WebAuthnHarness("vault.mida.xyz");
        fixture = vm.readFile("test/vectors/webauthn-v1.json");
        challenge = vm.parseJsonBytes32(fixture, ".challenge");
        qx = uint256(vm.parseJsonBytes32(fixture, ".qx"));
        qy = uint256(vm.parseJsonBytes32(fixture, ".qy"));
        auth = WebAuthn.WebAuthnAuth({
            authenticatorData: vm.parseJsonBytes(fixture, ".authenticatorData"),
            clientDataJSON: vm.parseJsonString(fixture, ".clientDataJSON"),
            challengeIndex: vm.parseJsonUint(fixture, ".challengeIndex"),
            typeIndex: vm.parseJsonUint(fixture, ".typeIndex"),
            r: uint256(vm.parseJsonBytes32(fixture, ".r")),
            s: uint256(vm.parseJsonBytes32(fixture, ".s"))
        });
    }

    /// @dev Calls 0x100 directly with the fixture's 160-byte input. An absent precompile is an empty
    ///      account: the call succeeds with empty return data.
    function _precompilePresent() internal view returns (bool) {
        bytes32 messageHash = sha256(abi.encodePacked(auth.authenticatorData, sha256(bytes(auth.clientDataJSON))));
        (bool ok, bytes memory ret) = address(0x100).staticcall(abi.encode(messageHash, auth.r, auth.s, qx, qy));
        return ok && ret.length == 32 && abi.decode(ret, (uint256)) == 1;
    }

    function _measuredVerifyGas() internal view returns (uint256 used) {
        uint256 before = gasleft();
        bool verified = harness.verify(challenge, auth, qx, qy);
        used = before - gasleft();
        assertTrue(verified, "fixture must verify on this path");
    }

    function test_nativePrecompilePath() public {
        vm.skip(!_precompilePresent(), "P256VERIFY absent at 0x100; this run proves the fallback path");
        uint256 used = _measuredVerifyGas();
        emit log_named_uint("native P256 verify gas", used);
        assertLt(used, NATIVE_MAX_GAS);
    }

    function test_solidityFallbackPath() public {
        vm.skip(_precompilePresent(), "P256VERIFY present at 0x100; rerun with --evm-version prague");
        uint256 used = _measuredVerifyGas();
        emit log_named_uint("FreshCryptoLib P256 verify gas", used);
        assertGt(used, FALLBACK_MIN_GAS);
    }
}
