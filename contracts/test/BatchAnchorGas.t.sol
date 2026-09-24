// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PERM_CREATE, PERM_SUPERSEDE_OWN, PROV_ALLOW_INFERENCE, SOURCE_AGENT_INFERRED} from "../src/MidaTypes.sol";
import {BatchAnchor} from "../src/BatchAnchor.sol";
import {ContextRegistry} from "../src/ContextRegistry.sol";
import {BatchFixtures} from "./utils/BatchFixtures.sol";

/// @notice Plan Task 3: local gas estimates only — one `submitBatch` per size against a fresh
///         deployment, so every number includes the first-write costs a real batch pays (the
///         hasBatchedSaves flag, fresh lineage slots). The evidence file uses testnet numbers
///         (plan Task 11); these are for sizing.
contract BatchAnchorGasTest is BatchFixtures {
    TestOwner internal alice;
    TestAgent internal writer;

    function setUp() public {
        _deployAnchor();
        alice = _ownerWithKey("alice");
        writer = _register(registry, "agent-w");
        _initEpoch(alice, "goals.career");
        _grantExact(
            alice, writer, _one(_scope("goals.career", PERM_CREATE | PERM_SUPERSEDE_OWN, PROV_ALLOW_INFERENCE)), 0
        );
    }

    function _rootSaves(uint256 n) internal view returns (BatchAnchor.SignedSave[] memory saves) {
        saves = new BatchAnchor.SignedSave[](n);
        for (uint256 i = 0; i < n; i++) {
            saves[i] = _rootSave(alice.owner, "goals.career", string.concat("cp-", vm.toString(i)), writer.signerKey);
        }
    }

    function _measure(uint256 n) internal {
        uint256 gasBefore = gasleft();
        (, uint32 accepted) = anchor.submitBatch(keccak256(abi.encode("batch-gas", n)), _rootSaves(n));
        uint256 used = gasBefore - gasleft();
        assertEq(uint256(accepted), n);
        emit log_named_uint(string.concat("batch_", vm.toString(n), "_per_save"), used / n);
    }

    function test_gas_batch_1() public {
        _measure(1);
    }

    function test_gas_batch_8() public {
        _measure(8);
    }

    function test_gas_batch_32() public {
        _measure(32);
    }

    function test_gas_batch_128() public {
        _measure(128);
    }

    function test_gas_batch_256() public {
        _measure(256);
    }

    function test_gas_direct_register() public {
        ContextRegistry.ContextInput memory input =
            _contextInput(alice.owner, writer.agentId, "goals.career", "direct-1", EPISODE, SOURCE_AGENT_INFERRED);
        uint256 gasBefore = gasleft();
        _submit(writer.signer, alice.owner, input);
        emit log_named_uint("direct_per_save", gasBefore - gasleft());
    }
}
