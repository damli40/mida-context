// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {
    AnchorOwnerOnly,
    CapabilityDenied,
    EpochStale,
    EvidenceImmutable,
    LINEAGE_OWNER_CONTROLLED,
    LINEAGE_STANDARD,
    PERM_CREATE,
    PERM_READ,
    PERM_SUPERSEDE_ANY,
    PERM_SUPERSEDE_OWN,
    PROV_ALLOW_INFERENCE,
    ProvenanceForbidden,
    SOURCE_AGENT_INFERRED,
    SOURCE_USER_ASSERTED,
    SOURCE_USER_CONFIRMED,
    StaleParent
} from "../src/MidaTypes.sol";
import {ContextRegistry} from "../src/ContextRegistry.sol";
import {Revocations} from "../src/Revocations.sol";
import {ContextFixtures} from "./utils/ContextFixtures.sol";

/// @notice §11.6 supersession, §11.5 owner-controlled anchors, §3.2 FAFO concurrency, and §15 Anchor,
///         Evidence, Lineage and Concurrency rows.
contract ContextLineageTest is ContextFixtures {
    uint8 internal constant GOAL = 3;

    TestOwner internal alice;
    TestAgent internal ownAgent;
    TestAgent internal anyAgent;
    bytes32 internal aliceRoot;

    function setUp() public {
        _deployContexts();
        alice = _ownerWithKey("alice");
        ownAgent = _register(registry, "agent-own");
        anyAgent = _register(registry, "agent-any");
        _initEpoch(alice, "goals.career");
        _initEpoch(alice, "projects.current");
        _grantExact(
            alice, ownAgent, _one(_scope("goals.career", PERM_CREATE | PERM_SUPERSEDE_OWN, PROV_ALLOW_INFERENCE)), 0
        );
        _grantExact(
            alice, anyAgent, _one(_scope("goals.career", PERM_CREATE | PERM_SUPERSEDE_ANY, PROV_ALLOW_INFERENCE)), 0
        );
        aliceRoot = _submit(
            alice.owner, alice.owner, _contextInput(alice.owner, bytes32(0), "goals.career", "alice-root", GOAL, SOURCE_USER_ASSERTED)
        );
    }

    function _successor(
        address owner,
        bytes32 authorId,
        string memory namespaceName,
        bytes32 parentId,
        string memory label,
        uint8 source
    ) internal view returns (ContextRegistry.ContextInput memory input) {
        input = _contextInput(owner, authorId, namespaceName, label, GOAL, source);
        input.expectedParentId = parentId;
    }

    // ---------------------------------------------------------------- owner supersession

    function test_ownerSupersedesAndLineageFieldsAreDerived() public {
        ContextRegistry.ContextInput memory next =
            _successor(alice.owner, bytes32(0), "goals.career", aliceRoot, "alice-v2", SOURCE_USER_ASSERTED);
        vm.expectEmit(address(contexts));
        emit ContextRegistry.ContextSuperseded(alice.owner, aliceRoot, next.contextId, aliceRoot, 2);
        bytes32 v2 = _submit(alice.owner, alice.owner, next);

        ContextRegistry.ContextRecord memory record = contexts.getRecord(v2);
        assertEq(record.lineageId, aliceRoot);
        assertEq(record.parentId, aliceRoot);
        assertEq(record.version, 2);
        assertEq(contexts.latest(aliceRoot), v2);
    }

    /// @dev §15 "same current parent superseded twice": second gets STALE_PARENT.
    function test_secondSupersessionOfSameParentIsStale() public {
        bytes32 first = _submit(
            alice.owner, alice.owner, _successor(alice.owner, bytes32(0), "goals.career", aliceRoot, "first", SOURCE_USER_ASSERTED)
        );
        ContextRegistry.ContextInput memory second =
            _successor(alice.owner, bytes32(0), "goals.career", aliceRoot, "second", SOURCE_USER_ASSERTED);
        _expectSubmitRevert(alice.owner, alice.owner, second, abi.encodeWithSelector(StaleParent.selector, aliceRoot, first));
        assertEq(contexts.latest(aliceRoot), first);
    }

    function test_staleParentInsideOneBatchRevertsTheBatch() public {
        ContextRegistry.ContextInput[] memory inputs = new ContextRegistry.ContextInput[](2);
        inputs[0] = _successor(alice.owner, bytes32(0), "goals.career", aliceRoot, "batch-a", SOURCE_USER_ASSERTED);
        inputs[1] = _successor(alice.owner, bytes32(0), "goals.career", aliceRoot, "batch-b", SOURCE_USER_ASSERTED);
        vm.prank(alice.owner);
        vm.expectRevert(abi.encodeWithSelector(StaleParent.selector, aliceRoot, inputs[0].contextId));
        contexts.register(alice.owner, inputs);
        assertEq(contexts.latest(aliceRoot), aliceRoot);
    }

    function testFuzz_onlyTheCurrentHeadCanBeSuperseded(uint8 depthSeed, uint8 pickSeed) public {
        uint256 depth = bound(depthSeed, 1, 8);
        bytes32[] memory chain = new bytes32[](depth + 1);
        chain[0] = aliceRoot;
        for (uint256 i = 1; i <= depth; i++) {
            chain[i] = _submit(
                alice.owner,
                alice.owner,
                _successor(alice.owner, bytes32(0), "goals.career", chain[i - 1], string.concat("fuzz-", vm.toString(i)), SOURCE_USER_ASSERTED)
            );
        }
        uint256 pick = bound(pickSeed, 0, depth);
        ContextRegistry.ContextInput memory attempt =
            _successor(alice.owner, bytes32(0), "goals.career", chain[pick], "fuzz-attempt", SOURCE_USER_ASSERTED);
        if (pick == depth) {
            bytes32 head = _submit(alice.owner, alice.owner, attempt);
            assertEq(contexts.getRecord(head).version, depth + 2);
            assertEq(contexts.latest(aliceRoot), head);
        } else {
            _expectSubmitRevert(alice.owner, alice.owner, attempt, abi.encodeWithSelector(StaleParent.selector, chain[pick], chain[depth]));
            assertEq(contexts.latest(aliceRoot), chain[depth]);
        }
    }

    /// @dev §15 "independent roots/lineages created concurrently": two lineages advance in one batch.
    function test_independentLineagesAdvanceTogether() public {
        bytes32 otherRoot = _submit(
            alice.owner, alice.owner, _contextInput(alice.owner, bytes32(0), "goals.career", "other-root", GOAL, SOURCE_USER_ASSERTED)
        );
        ContextRegistry.ContextInput[] memory inputs = new ContextRegistry.ContextInput[](2);
        inputs[0] = _successor(alice.owner, bytes32(0), "goals.career", aliceRoot, "lineage-1-v2", SOURCE_USER_ASSERTED);
        inputs[1] = _successor(alice.owner, bytes32(0), "goals.career", otherRoot, "lineage-2-v2", SOURCE_USER_ASSERTED);
        vm.prank(alice.owner);
        bytes32[] memory ids = contexts.register(alice.owner, inputs);
        assertEq(contexts.latest(aliceRoot), ids[0]);
        assertEq(contexts.latest(otherRoot), ids[1]);
    }

    // ---------------------------------------------------------------- agent supersession rules

    function test_supersedeOwnWorksOnlyOnOwnLineage() public {
        bytes32 agentRoot = _submit(
            ownAgent.signer,
            alice.owner,
            _contextInput(alice.owner, ownAgent.agentId, "goals.career", "own-root", GOAL, SOURCE_AGENT_INFERRED)
        );
        _submit(
            ownAgent.signer,
            alice.owner,
            _successor(alice.owner, ownAgent.agentId, "goals.career", agentRoot, "own-v2", SOURCE_AGENT_INFERRED)
        );
        ContextRegistry.ContextInput memory othersLineage =
            _successor(alice.owner, ownAgent.agentId, "goals.career", aliceRoot, "own-on-alice", SOURCE_AGENT_INFERRED);
        _expectSubmitRevert(ownAgent.signer, alice.owner, othersLineage, abi.encodeWithSelector(CapabilityDenied.selector));
    }

    function test_supersedeAnyWorksOnAnotherAuthorsStandardLineage() public {
        bytes32 agentRoot = _submit(
            ownAgent.signer,
            alice.owner,
            _contextInput(alice.owner, ownAgent.agentId, "goals.career", "own-root", GOAL, SOURCE_AGENT_INFERRED)
        );
        bytes32 v2 = _submit(
            anyAgent.signer,
            alice.owner,
            _successor(alice.owner, anyAgent.agentId, "goals.career", agentRoot, "any-v2", SOURCE_AGENT_INFERRED)
        );
        assertEq(contexts.getRecord(v2).author, anyAgent.agentId);
        _submit(
            anyAgent.signer,
            alice.owner,
            _successor(alice.owner, anyAgent.agentId, "goals.career", aliceRoot, "any-on-alice", SOURCE_AGENT_INFERRED)
        );
    }

    function test_createOnlyAgentCannotSupersede() public {
        TestAgent memory creator = _register(registry, "agent-create");
        _grantExact(alice, creator, _one(_scope("goals.career", PERM_CREATE, PROV_ALLOW_INFERENCE)), 0);
        bytes32 creatorRoot = _submit(
            creator.signer,
            alice.owner,
            _contextInput(alice.owner, creator.agentId, "goals.career", "creator-root", GOAL, SOURCE_AGENT_INFERRED)
        );
        ContextRegistry.ContextInput memory next =
            _successor(alice.owner, creator.agentId, "goals.career", creatorRoot, "creator-v2", SOURCE_AGENT_INFERRED);
        _expectSubmitRevert(creator.signer, alice.owner, next, abi.encodeWithSelector(CapabilityDenied.selector));
    }

    function test_supersessionProvenanceBitsMustComeFromTheSupersedeCapability() public {
        TestAgent memory split = _register(registry, "agent-split");
        _grantExact(alice, split, _one(_scope("goals.career", PERM_CREATE, PROV_ALLOW_INFERENCE)), 0);
        _grantExact(alice, split, _one(_scope("goals.career", PERM_SUPERSEDE_OWN, 0)), 0);
        bytes32 splitRoot = _submit(
            split.signer,
            alice.owner,
            _contextInput(alice.owner, split.agentId, "goals.career", "split-root", GOAL, SOURCE_AGENT_INFERRED)
        );
        ContextRegistry.ContextInput memory next =
            _successor(alice.owner, split.agentId, "goals.career", splitRoot, "split-v2", SOURCE_AGENT_INFERRED);
        _expectSubmitRevert(split.signer, alice.owner, next, abi.encodeWithSelector(ProvenanceForbidden.selector));
    }

    // ---------------------------------------------------------------- anchors (§11.5, §11.6)

    /// @dev §15 "SUPERSEDE_ANY agent edits owner-controlled lineage".
    function test_noAgentMaySupersedeAnOwnerControlledLineage() public {
        ContextRegistry.ContextInput memory anchorInput =
            _contextInput(alice.owner, bytes32(0), "goals.career", "anchor", GOAL, SOURCE_USER_ASSERTED);
        anchorInput.lineagePolicy = LINEAGE_OWNER_CONTROLLED;
        bytes32 anchor = _submit(alice.owner, alice.owner, anchorInput);

        ContextRegistry.ContextInput memory edit =
            _successor(alice.owner, anyAgent.agentId, "goals.career", anchor, "any-edit", SOURCE_AGENT_INFERRED);
        edit.lineagePolicy = LINEAGE_OWNER_CONTROLLED;
        _expectSubmitRevert(anyAgent.signer, alice.owner, edit, abi.encodeWithSelector(AnchorOwnerOnly.selector));
        assertEq(contexts.latest(anchor), anchor);
    }

    /// @dev §15 "agent creates separate proposal": accepted with inference policy; anchor head unchanged.
    function test_agentProposalIsASeparateLineage() public {
        ContextRegistry.ContextInput memory anchorInput =
            _contextInput(alice.owner, bytes32(0), "goals.career", "anchor", GOAL, SOURCE_USER_ASSERTED);
        anchorInput.lineagePolicy = LINEAGE_OWNER_CONTROLLED;
        bytes32 anchor = _submit(alice.owner, alice.owner, anchorInput);

        ContextRegistry.ContextInput memory proposal =
            _contextInput(alice.owner, anyAgent.agentId, "goals.career", "proposal", GOAL, SOURCE_AGENT_INFERRED);
        proposal.evidenceCommitment = keccak256(abi.encode("supports", anchor));
        bytes32 proposalId = _submit(anyAgent.signer, alice.owner, proposal);

        assertEq(contexts.latest(proposalId), proposalId);
        assertEq(contexts.latest(anchor), anchor, "a generic reference never moves the anchor head");
    }

    function test_ownerControlledStatusCannotBeAddedOrRemoved() public {
        ContextRegistry.ContextInput memory anchorInput =
            _contextInput(alice.owner, bytes32(0), "goals.career", "anchor", GOAL, SOURCE_USER_ASSERTED);
        anchorInput.lineagePolicy = LINEAGE_OWNER_CONTROLLED;
        bytes32 anchor = _submit(alice.owner, alice.owner, anchorInput);

        ContextRegistry.ContextInput memory removes =
            _successor(alice.owner, bytes32(0), "goals.career", anchor, "remove-policy", SOURCE_USER_ASSERTED);
        _expectSubmitRevert(alice.owner, alice.owner, removes, abi.encodeWithSelector(ContextRegistry.InvalidRecord.selector, removes.contextId));

        ContextRegistry.ContextInput memory keeps =
            _successor(alice.owner, bytes32(0), "goals.career", anchor, "keep-policy", SOURCE_USER_ASSERTED);
        keeps.lineagePolicy = LINEAGE_OWNER_CONTROLLED;
        _submit(alice.owner, alice.owner, keeps);

        ContextRegistry.ContextInput memory adds =
            _successor(alice.owner, bytes32(0), "goals.career", aliceRoot, "add-policy", SOURCE_USER_ASSERTED);
        adds.lineagePolicy = LINEAGE_OWNER_CONTROLLED;
        _expectSubmitRevert(alice.owner, alice.owner, adds, abi.encodeWithSelector(ContextRegistry.InvalidRecord.selector, adds.contextId));
    }

    /// @dev §11.8: a user-confirmed successor may edit an agent proposal.
    function test_ownerMayConfirmAndSupersedeAnAgentLineage() public {
        bytes32 agentRoot = _submit(
            ownAgent.signer,
            alice.owner,
            _contextInput(alice.owner, ownAgent.agentId, "goals.career", "own-root", GOAL, SOURCE_AGENT_INFERRED)
        );
        ContextRegistry.ContextInput memory confirmed =
            _successor(alice.owner, bytes32(0), "goals.career", agentRoot, "confirmed", SOURCE_USER_CONFIRMED);
        confirmed.evidenceCommitment = keccak256(abi.encode("confirmed_from", agentRoot));
        bytes32 v2 = _submit(alice.owner, alice.owner, confirmed);
        assertEq(contexts.getRecord(v2).author, bytes32(0));
        assertEq(contexts.latest(agentRoot), v2);
    }

    // ---------------------------------------------------------------- parents

    /// @dev §15 "supersede evidence": EVIDENCE_IMMUTABLE.
    function test_evidenceCannotBeSuperseded() public {
        bytes32 evidence = _submit(alice.owner, alice.owner, _evidenceInput(alice.owner, bytes32(0), "goals.career", "cv"));
        ContextRegistry.ContextInput memory next =
            _successor(alice.owner, bytes32(0), "goals.career", evidence, "on-evidence", SOURCE_USER_ASSERTED);
        _expectSubmitRevert(alice.owner, alice.owner, next, abi.encodeWithSelector(EvidenceImmutable.selector, evidence));
    }

    function test_parentMustExistWithSameOwnerAndNamespace() public {
        ContextRegistry.ContextInput memory missing =
            _successor(alice.owner, bytes32(0), "goals.career", keccak256("nothing"), "missing", SOURCE_USER_ASSERTED);
        _expectSubmitRevert(
            alice.owner, alice.owner, missing, abi.encodeWithSelector(ContextRegistry.ContextNotFound.selector, keccak256("nothing"))
        );

        ContextRegistry.ContextInput memory otherNamespace =
            _successor(alice.owner, bytes32(0), "projects.current", aliceRoot, "cross-namespace", SOURCE_USER_ASSERTED);
        _expectSubmitRevert(
            alice.owner, alice.owner, otherNamespace, abi.encodeWithSelector(ContextRegistry.ParentMismatch.selector, aliceRoot)
        );

        TestOwner memory bob = _ownerWithKey("bob");
        _initEpoch(bob, "goals.career");
        ContextRegistry.ContextInput memory otherOwner =
            _successor(bob.owner, bytes32(0), "goals.career", aliceRoot, "cross-owner", SOURCE_USER_ASSERTED);
        _expectSubmitRevert(
            bob.owner, bob.owner, otherOwner, abi.encodeWithSelector(ContextRegistry.ParentMismatch.selector, aliceRoot)
        );
    }

    // ---------------------------------------------------------------- epochs and revocation on supersession

    function test_supersessionUsesTheCurrentEpoch() public {
        TestAgent memory reader = _register(registry, "agent-reader");
        bytes32 readCap = _grantExact(alice, reader, _one(_scope("goals.career", PERM_READ, 0)), 0)[0];
        ContextRegistry.ContextInput memory oldEpoch =
            _successor(alice.owner, bytes32(0), "goals.career", aliceRoot, "old-epoch-v2", SOURCE_USER_ASSERTED);
        vm.prank(alice.owner);
        registry.revokeAndRotate(readCap, _epochKey(alice.owner, "goals.career", 2));
        _expectSubmitRevert(
            alice.owner,
            alice.owner,
            oldEpoch,
            abi.encodeWithSelector(EpochStale.selector, _ns("goals.career"), uint64(1), uint64(2))
        );
    }

    function test_revokedAgentCannotSupersede() public {
        bytes32 agentRoot = _submit(
            ownAgent.signer,
            alice.owner,
            _contextInput(alice.owner, ownAgent.agentId, "goals.career", "own-root", GOAL, SOURCE_AGENT_INFERRED)
        );
        vm.prank(alice.owner);
        registry.revokeAgentAndRotate(ownAgent.agentId, new Revocations.EpochRotation[](0));
        ContextRegistry.ContextInput memory next =
            _successor(alice.owner, ownAgent.agentId, "goals.career", agentRoot, "revoked-v2", SOURCE_AGENT_INFERRED);
        _expectSubmitRevert(ownAgent.signer, alice.owner, next, abi.encodeWithSelector(CapabilityDenied.selector));
    }

    function test_lineagePolicyDefaultIsStandard() public view {
        assertEq(contexts.getRecord(aliceRoot).lineagePolicy, LINEAGE_STANDARD);
    }
}
