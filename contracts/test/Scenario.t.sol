// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {
    AccessRequestInput,
    CapabilityDenied,
    EpochStale,
    GrantScope,
    PERM_CREATE,
    PERM_READ,
    PROV_ALLOW_INFERENCE,
    SOURCE_AGENT_INFERRED,
    SOURCE_USER_ASSERTED
} from "../src/MidaTypes.sol";
import {ContextRegistry} from "../src/ContextRegistry.sol";
import {ContextFixtures} from "./utils/ContextFixtures.sol";

/// @notice The on-chain half of the spec §16 end-to-end scenario, as one test. Steps that are off-chain
///         (manifest and advisor evaluation, wraps, decryption, API deny overlay) are proven in Part E; this
///         test proves the chain allows or denies exactly what those steps assume.
contract ScenarioTest is ContextFixtures {
    uint8 internal constant GOAL = 3;

    function test_section16OnChainSteps() public {
        _deployContexts();

        // 1. Alice registers her owner P256 key and the goals.career epoch-1 public key.
        TestOwner memory alice = _ownerWithKey("alice");
        _initEpoch(alice, "goals.career");
        bytes32 career = _ns("goals.career");

        // 2. Agents A, B, C (and remaining reader D) register with signer proofs and manifest commitments.
        TestAgent memory agentA = _register(registry, "agent-a");
        TestAgent memory agentB = _register(registry, "agent-b");
        TestAgent memory agentC = _register(registry, "agent-c");
        TestAgent memory agentD = _register(registry, "agent-d");

        // 3. Alice creates encrypted goals.career context under epoch 1.
        bytes32 aliceContext = _submit(
            alice.owner, alice.owner, _contextInput(alice.owner, bytes32(0), "goals.career", "s16-alice", GOAL, SOURCE_USER_ASSERTED)
        );
        assertEq(contexts.getRecord(aliceContext).readEpoch, 1);

        // 4-6. A requests READ goals.career plus unnecessary READ financial; Alice approves only READ goals.career.
        GrantScope[] memory requested = _two(_scope("goals.career", PERM_READ, 0), _scope("financial", PERM_READ, 0));
        AccessRequestInput memory request = _request(agentA, requested, 0);
        bytes32 capA = _grant(alice, request, _one(_scope("goals.career", PERM_READ, 0)), 0)[0];
        assertTrue(registry.isAuthorized(alice.owner, agentA.agentId, career, PERM_READ));
        assertFalse(registry.isAuthorized(alice.owner, agentA.agentId, _ns("financial"), PERM_READ), "financial was not granted");
        _grantExact(alice, agentD, _one(_scope("goals.career", PERM_READ, 0)), 0);

        // 9. Agent B has no grant.
        assertFalse(registry.isAuthorized(alice.owner, agentB.agentId, career, PERM_READ));
        _expectSubmitRevert(
            agentB.signer,
            alice.owner,
            _contextInput(alice.owner, agentB.agentId, "goals.career", "s16-b", GOAL, SOURCE_AGENT_INFERRED),
            abi.encodeWithSelector(CapabilityDenied.selector)
        );

        // 10-12. C gets exact CREATE goals.career without READ and creates a new lineage.
        _grantExact(alice, agentC, _one(_scope("goals.career", PERM_CREATE, PROV_ALLOW_INFERENCE)), 0);
        assertFalse(registry.isAuthorized(alice.owner, agentC.agentId, career, PERM_READ), "CREATE does not imply READ");
        bytes32 cEpoch1 = _submit(
            agentC.signer, alice.owner, _contextInput(alice.owner, agentC.agentId, "goals.career", "s16-c-1", GOAL, SOURCE_AGENT_INFERRED)
        );
        assertEq(contexts.latest(cEpoch1), cEpoch1);

        // 14. Alice revokes A and advances goals.career to epoch 2 in one transaction.
        ContextRegistry.ContextInput memory staleAfterRevoke =
            _contextInput(alice.owner, agentC.agentId, "goals.career", "s16-c-stale", GOAL, SOURCE_AGENT_INFERRED);
        vm.prank(alice.owner);
        registry.revokeAndRotate(capA, _epochKey(alice.owner, "goals.career", 2));
        assertEq(registry.requiredReadEpoch(alice.owner, career), 2);
        _expectSubmitRevert(
            agentC.signer, alice.owner, staleAfterRevoke, abi.encodeWithSelector(EpochStale.selector, career, uint64(1), uint64(2))
        );

        // 15. C writes a new object under epoch 2.
        bytes32 cEpoch2 = _submit(
            agentC.signer, alice.owner, _contextInput(alice.owner, agentC.agentId, "goals.career", "s16-c-2", GOAL, SOURCE_AGENT_INFERRED)
        );
        assertEq(contexts.getRecord(cEpoch2).readEpoch, 2);

        // 16-17. A's chain authorization fails; the remaining reader D is still authorized.
        assertFalse(registry.isAuthorized(alice.owner, agentA.agentId, career, PERM_READ));
        assertTrue(registry.isAuthorized(alice.owner, agentD.agentId, career, PERM_READ));
    }
}
