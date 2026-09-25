// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// Gas measurement (Sep 24 sizing evidence, docs/evidence/batch-anchor-multi-owner-local-2026-09-24.json): does a batch cost more per save when its
// saves come from many owners, or are updates instead of new saves? Run with `--isolate` so every
// submitBatch is its own transaction and storage starts cold, as it does on chain.

import {PERM_CREATE, PERM_SUPERSEDE_OWN, PROV_ALLOW_INFERENCE} from "../src/MidaTypes.sol";
import {BatchAnchor} from "../src/BatchAnchor.sol";
import {BatchFixtures} from "./utils/BatchFixtures.sol";

contract MultiOwnerGasTest is BatchFixtures {
    uint256 internal constant N = 32;
    string internal constant AREA = "goals.career";

    TestOwner[] internal owners;
    TestAgent[] internal agents;

    function setUp() public {
        _deployAnchor();
        for (uint256 i = 0; i < N; i++) {
            TestOwner memory o = _ownerWithKey(string.concat("owner-", vm.toString(i)));
            TestAgent memory a = _register(registry, string.concat("agent-", vm.toString(i)));
            _initEpoch(o, AREA);
            _grantExact(o, a, _one(_scope(AREA, PERM_CREATE | PERM_SUPERSEDE_OWN, PROV_ALLOW_INFERENCE)), 0);
            owners.push(o);
            agents.push(a);
        }
    }

    /// saves[i] from owner (manyOwners ? i : 0), signed by that owner's agent
    function _roots(bool manyOwners, string memory tag) internal view returns (BatchAnchor.SignedSave[] memory saves) {
        saves = new BatchAnchor.SignedSave[](N);
        for (uint256 i = 0; i < N; i++) {
            uint256 k = manyOwners ? i : 0;
            saves[i] = _rootSave(owners[k].owner, AREA, string.concat(tag, vm.toString(i)), agents[k].signerKey);
        }
    }

    function _children(BatchAnchor.SignedSave[] memory parents, bool manyOwners)
        internal
        view
        returns (BatchAnchor.SignedSave[] memory saves)
    {
        saves = new BatchAnchor.SignedSave[](N);
        for (uint256 i = 0; i < N; i++) {
            uint256 k = manyOwners ? i : 0;
            bytes32 parentId = _contextIdOf(parents[i], agents[k].agentId);
            // a root save's lineageId is its own contextId; rootAuthor is its agent
            saves[i] = _childOf(
                parents[i], agents[k].agentId, 1, parentId, agents[k].agentId, string.concat("child-", vm.toString(i)), agents[k].signerKey
            );
        }
    }

    function _measure(string memory label, bytes32 batchId, BatchAnchor.SignedSave[] memory saves) internal {
        uint256 gasBefore = gasleft();
        (, uint32 accepted) = anchor.submitBatch(batchId, saves);
        uint256 used = gasBefore - gasleft();
        assertEq(uint256(accepted), N, "every save must be accepted");
        emit log_named_uint(label, used / N);
    }

    function test_a_oneOwner_newSaves() public {
        _measure("a_one_owner_new_per_save", "a", _roots(false, "a-"));
    }

    function test_b_manyOwners_firstEver() public {
        _measure("b_32_owners_first_batch_ever_per_save", "b", _roots(true, "b-"));
    }

    function test_c_manyOwners_returning() public {
        anchor.submitBatch("c0", _roots(true, "c0-"));
        _measure("c_32_owners_returning_per_save", "c1", _roots(true, "c1-"));
    }

    function test_d_oneOwner_updates() public {
        BatchAnchor.SignedSave[] memory parents = _roots(false, "d-");
        anchor.submitBatch("d0", parents);
        _measure("d_one_owner_updates_per_save", "d1", _children(parents, false));
    }

    function test_e_manyOwners_updates() public {
        BatchAnchor.SignedSave[] memory parents = _roots(true, "e-");
        anchor.submitBatch("e0", parents);
        _measure("e_32_owners_updates_per_save", "e1", _children(parents, true));
    }

    function _rootsN(uint256 n, bool manyOwners, string memory tag) internal view returns (BatchAnchor.SignedSave[] memory saves) {
        saves = new BatchAnchor.SignedSave[](n);
        for (uint256 i = 0; i < n; i++) {
            uint256 k = manyOwners ? i : 0;
            saves[i] = _rootSave(owners[k].owner, AREA, string.concat(tag, vm.toString(i)), agents[k].signerKey);
        }
    }

    /// small batches from owners who already have batched saves (the trial's steady state)
    function _small(uint256 n, bool manyOwners, string memory label) internal {
        anchor.submitBatch(keccak256(abi.encode(label, "warmup")), _rootsN(N, true, string.concat(label, "-w-")));
        BatchAnchor.SignedSave[] memory saves = _rootsN(n, manyOwners, string.concat(label, "-m-"));
        uint256 gasBefore = gasleft();
        (, uint32 accepted) = anchor.submitBatch(keccak256(abi.encode(label)), saves);
        uint256 used = gasBefore - gasleft();
        assertEq(uint256(accepted), n);
        emit log_named_uint(label, used / n);
    }

    function test_f_small_1() public { _small(1, false, "f_batch_of_1_returning_per_save"); }
    function test_f_small_2_owners() public { _small(2, true, "f_batch_of_2_two_owners_per_save"); }
    function test_f_small_4_owners() public { _small(4, true, "f_batch_of_4_four_owners_per_save"); }
    function test_f_small_8_one_owner() public { _small(8, false, "f_batch_of_8_one_owner_per_save"); }
}
