// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {
    AnchorOwnerOnly,
    CapabilityDenied,
    EpochRotationRequired,
    EpochStale,
    InvalidNamespace,
    KIND_NONE,
    LINEAGE_OWNER_CONTROLLED,
    PERM_CREATE,
    PERM_READ,
    PROV_ALLOW_IMPORTED,
    PROV_ALLOW_INFERENCE,
    ProvenanceForbidden,
    SOURCE_AGENT_INFERRED,
    SOURCE_EXTERNAL_ATTESTATION,
    SOURCE_IMPORTED,
    SOURCE_NONE,
    SOURCE_USER_ASSERTED,
    SOURCE_USER_CONFIRMED
} from "../src/MidaTypes.sol";
import {ContextRegistry} from "../src/ContextRegistry.sol";
import {ICapabilityRegistry} from "../src/ICapabilityRegistry.sol";
import {ContextFixtures} from "./utils/ContextFixtures.sol";

/// @notice §11.4 registration rules, §11.5 roots, §11.7 evidence, §11.8 provenance, and the write side of
///         §15 CREATE, Revocation, Expiry, Provenance, Anchor, Evidence and Concurrency rows.
contract ContextRootsTest is ContextFixtures {
    uint8 internal constant GOAL = 3;
    uint8 internal constant FACT = 1;

    TestOwner internal alice;
    TestAgent internal readerA;
    TestAgent internal agentB;
    TestAgent internal creatorC;
    bytes32 internal capA;

    function setUp() public {
        _deployContexts();
        alice = _ownerWithKey("alice");
        readerA = _register(registry, "agent-a");
        agentB = _register(registry, "agent-b");
        creatorC = _register(registry, "agent-c");
        _initEpoch(alice, "goals.career");
        capA = _grantExact(alice, readerA, _one(_scope("goals.career", PERM_READ, 0)), 0)[0];
        _grantExact(alice, creatorC, _one(_scope("goals.career", PERM_CREATE, PROV_ALLOW_INFERENCE)), 0);
    }

    function test_constructorRejectsZeroRegistry() public {
        vm.expectRevert(ContextRegistry.ZeroRegistry.selector);
        new ContextRegistry(ICapabilityRegistry(address(0)));
    }

    // ---------------------------------------------------------------- roots and derived fields

    function test_ownerRegistersRootWithDerivedFields() public {
        ContextRegistry.ContextInput memory input =
            _contextInput(alice.owner, bytes32(0), "goals.career", "alice-goal-1", GOAL, SOURCE_USER_ASSERTED);
        bytes32 contextId = _submit(alice.owner, alice.owner, input);

        ContextRegistry.ContextRecord memory record = contexts.getRecord(contextId);
        assertEq(record.contextId, input.contextId);
        assertEq(record.owner, alice.owner);
        assertEq(record.author, bytes32(0));
        assertEq(record.lineageId, contextId);
        assertEq(record.parentId, bytes32(0));
        assertEq(record.version, 1);
        assertEq(record.readEpoch, 1);
        assertEq(record.createdAt, block.timestamp);
        assertEq(record.manifestHash, input.manifestHash);
        assertEq(record.ciphertextCommitment, input.ciphertextCommitment);
        assertEq(contexts.latest(contextId), contextId);
        assertTrue(contexts.exists(contextId));
    }

    /// @dev §15 "caller forges version/lineage/author": the id binds author, so a forged author fails.
    function test_contextIdIsRecomputedWithDerivedAuthor() public {
        ContextRegistry.ContextInput memory claimsOwnerAuthor =
            _contextInput(alice.owner, bytes32(0), "goals.career", "forged", GOAL, SOURCE_AGENT_INFERRED);
        bytes32 expected = keccak256(
            abi.encode(
                string("MIDA_CONTEXT_OBJECT_V1"),
                block.chainid,
                address(contexts),
                alice.owner,
                creatorC.agentId,
                claimsOwnerAuthor.namespaceId,
                claimsOwnerAuthor.objectNonce
            )
        );
        _expectSubmitRevert(
            creatorC.signer,
            alice.owner,
            claimsOwnerAuthor,
            abi.encodeWithSelector(ContextRegistry.ContextIdMismatch.selector, expected, claimsOwnerAuthor.contextId)
        );
    }

    function test_duplicateAndUnknownNamespaceRejected() public {
        ContextRegistry.ContextInput memory input =
            _contextInput(alice.owner, bytes32(0), "goals.career", "dup", GOAL, SOURCE_USER_ASSERTED);
        _submit(alice.owner, alice.owner, input);
        _expectSubmitRevert(
            alice.owner, alice.owner, input, abi.encodeWithSelector(ContextRegistry.DuplicateContext.selector, input.contextId)
        );

        ContextRegistry.ContextInput memory unknown =
            _contextInput(alice.owner, bytes32(0), "goals.side", "unknown", GOAL, SOURCE_USER_ASSERTED);
        _expectSubmitRevert(
            alice.owner, alice.owner, unknown, abi.encodeWithSelector(InvalidNamespace.selector, _ns("goals.side"))
        );
    }

    /// @dev §4.1: a relayer calling directly is the relayer, not the owner.
    function test_relayerCannotActForOwner() public {
        ContextRegistry.ContextInput memory input =
            _contextInput(alice.owner, bytes32(0), "goals.career", "relayed", GOAL, SOURCE_USER_ASSERTED);
        _expectSubmitRevert(address(0xBEEF), alice.owner, input, abi.encodeWithSelector(CapabilityDenied.selector));
    }

    function test_emptyBatchRejected() public {
        vm.prank(alice.owner);
        vm.expectRevert(ContextRegistry.EmptyBatch.selector);
        contexts.register(alice.owner, new ContextRegistry.ContextInput[](0));
    }

    function test_batchIsAtomic() public {
        ContextRegistry.ContextInput[] memory inputs = new ContextRegistry.ContextInput[](2);
        inputs[0] = _contextInput(alice.owner, bytes32(0), "goals.career", "batch-ok", GOAL, SOURCE_USER_ASSERTED);
        inputs[1] = _contextInput(alice.owner, bytes32(0), "goals.career", "batch-bad", GOAL, SOURCE_AGENT_INFERRED);
        vm.prank(alice.owner);
        vm.expectRevert(ProvenanceForbidden.selector);
        contexts.register(alice.owner, inputs);
        assertFalse(contexts.exists(inputs[0].contextId));
    }

    // ---------------------------------------------------------------- agent authority

    /// @dev §16 step 9: Agent B has no grant.
    function test_agentWithoutGrantDenied() public {
        ContextRegistry.ContextInput memory input =
            _contextInput(alice.owner, agentB.agentId, "goals.career", "b-write", GOAL, SOURCE_AGENT_INFERRED);
        _expectSubmitRevert(agentB.signer, alice.owner, input, abi.encodeWithSelector(CapabilityDenied.selector));
    }

    function test_readOnlyAgentCannotCreate() public {
        ContextRegistry.ContextInput memory input =
            _contextInput(alice.owner, readerA.agentId, "goals.career", "a-write", GOAL, SOURCE_AGENT_INFERRED);
        _expectSubmitRevert(readerA.signer, alice.owner, input, abi.encodeWithSelector(CapabilityDenied.selector));
    }

    /// @dev §15 "CREATE-only agent obtains epoch public key → new write succeeds"; §16 step 11.
    function test_createOnlyAgentWritesInferredRoot() public {
        ContextRegistry.ContextInput memory input =
            _contextInput(alice.owner, creatorC.agentId, "goals.career", "c-write", GOAL, SOURCE_AGENT_INFERRED);
        bytes32 contextId = _submit(creatorC.signer, alice.owner, input);
        assertEq(contexts.getRecord(contextId).author, creatorC.agentId);
        assertEq(contexts.latest(contextId), contextId);
    }

    function test_agentCannotCreateOwnerControlledRoot() public {
        ContextRegistry.ContextInput memory input =
            _contextInput(alice.owner, creatorC.agentId, "goals.career", "c-anchor", GOAL, SOURCE_AGENT_INFERRED);
        input.lineagePolicy = LINEAGE_OWNER_CONTROLLED;
        _expectSubmitRevert(creatorC.signer, alice.owner, input, abi.encodeWithSelector(AnchorOwnerOnly.selector));

        ContextRegistry.ContextInput memory anchor =
            _contextInput(alice.owner, bytes32(0), "goals.career", "alice-anchor", GOAL, SOURCE_USER_ASSERTED);
        anchor.lineagePolicy = LINEAGE_OWNER_CONTROLLED;
        bytes32 anchorId = _submit(alice.owner, alice.owner, anchor);
        assertEq(contexts.getRecord(anchorId).lineagePolicy, LINEAGE_OWNER_CONTROLLED);
    }

    // ---------------------------------------------------------------- epochs on the write path

    /// @dev §15 "write in old epoch after revoke" and "obsolete read-epoch object upload".
    function test_staleEpochRejectedAfterRotation() public {
        ContextRegistry.ContextInput memory oldEpoch =
            _contextInput(alice.owner, creatorC.agentId, "goals.career", "old-epoch", GOAL, SOURCE_AGENT_INFERRED);
        vm.prank(alice.owner);
        registry.revokeAndRotate(capA, _epochKey(alice.owner, "goals.career", 2));
        _expectSubmitRevert(
            creatorC.signer,
            alice.owner,
            oldEpoch,
            abi.encodeWithSelector(EpochStale.selector, _ns("goals.career"), uint64(1), uint64(2))
        );

        ContextRegistry.ContextInput memory newEpoch =
            _contextInput(alice.owner, creatorC.agentId, "goals.career", "new-epoch", GOAL, SOURCE_AGENT_INFERRED);
        assertEq(newEpoch.readEpoch, 2);
        _submit(creatorC.signer, alice.owner, newEpoch);
    }

    function test_uninitializedEpochRejected() public {
        _grantExact(alice, creatorC, _one(_scope("projects.current", PERM_CREATE, PROV_ALLOW_INFERENCE)), 0);
        ContextRegistry.ContextInput memory input =
            _contextInput(alice.owner, creatorC.agentId, "projects.current", "no-key", GOAL, SOURCE_AGENT_INFERRED);
        _expectSubmitRevert(
            creatorC.signer,
            alice.owner,
            input,
            abi.encodeWithSelector(EpochRotationRequired.selector, _ns("projects.current"), uint64(1))
        );
    }

    /// @dev §15 "write at exactly deadline", "write after deadline", "owner rotates after deadline".
    function test_writesCloseAtDeadlineAndResumeAfterRotation() public {
        TestAgent memory temporary = _register(registry, "agent-temp");
        uint64 deadline = uint64(block.timestamp + 1 hours);
        _grantExact(alice, temporary, _one(_scope("goals.career", PERM_READ, 0)), deadline);
        ContextRegistry.ContextInput memory atDeadline =
            _contextInput(alice.owner, bytes32(0), "goals.career", "at-deadline", GOAL, SOURCE_USER_ASSERTED);

        vm.warp(deadline);
        _expectSubmitRevert(
            alice.owner,
            alice.owner,
            atDeadline,
            abi.encodeWithSelector(EpochRotationRequired.selector, _ns("goals.career"), uint64(1))
        );

        vm.prank(alice.owner);
        registry.rotateExpiredEpoch(_ns("goals.career"), _epochKey(alice.owner, "goals.career", 2));
        ContextRegistry.ContextInput memory resumed =
            _contextInput(alice.owner, bytes32(0), "goals.career", "resumed", GOAL, SOURCE_USER_ASSERTED);
        _submit(alice.owner, alice.owner, resumed);
    }

    // ---------------------------------------------------------------- provenance (§11.8)

    /// @dev §15 "agent submits USER_ASSERTED" and "agent submits USER_CONFIRMED".
    function test_agentCannotClaimUserProvenance() public {
        ContextRegistry.ContextInput memory asserted =
            _contextInput(alice.owner, creatorC.agentId, "goals.career", "c-asserted", GOAL, SOURCE_USER_ASSERTED);
        _expectSubmitRevert(creatorC.signer, alice.owner, asserted, abi.encodeWithSelector(ProvenanceForbidden.selector));
        ContextRegistry.ContextInput memory confirmed =
            _contextInput(alice.owner, creatorC.agentId, "goals.career", "c-confirmed", GOAL, SOURCE_USER_CONFIRMED);
        confirmed.evidenceCommitment = keccak256("refs");
        _expectSubmitRevert(creatorC.signer, alice.owner, confirmed, abi.encodeWithSelector(ProvenanceForbidden.selector));
    }

    /// @dev §15 "owner submits USER_CONFIRMED without evidence commitment" and "owner labels a record AGENT_INFERRED".
    function test_ownerProvenanceRules() public {
        ContextRegistry.ContextInput memory confirmed =
            _contextInput(alice.owner, bytes32(0), "goals.career", "a-confirmed", GOAL, SOURCE_USER_CONFIRMED);
        _expectSubmitRevert(alice.owner, alice.owner, confirmed, abi.encodeWithSelector(ProvenanceForbidden.selector));
        confirmed.evidenceCommitment = keccak256("confirmed_from refs");
        _submit(alice.owner, alice.owner, confirmed);

        ContextRegistry.ContextInput memory inferred =
            _contextInput(alice.owner, bytes32(0), "goals.career", "a-inferred", GOAL, SOURCE_AGENT_INFERRED);
        _expectSubmitRevert(alice.owner, alice.owner, inferred, abi.encodeWithSelector(ProvenanceForbidden.selector));
    }

    function test_agentInferenceRequiresAllowInference() public {
        TestAgent memory plain = _register(registry, "agent-plain");
        _grantExact(alice, plain, _one(_scope("goals.career", PERM_CREATE, 0)), 0);
        ContextRegistry.ContextInput memory input =
            _contextInput(alice.owner, plain.agentId, "goals.career", "plain-inferred", GOAL, SOURCE_AGENT_INFERRED);
        _expectSubmitRevert(plain.signer, alice.owner, input, abi.encodeWithSelector(ProvenanceForbidden.selector));
    }

    function test_provenanceBitsMustComeFromTheCreateCapability() public {
        TestAgent memory split = _register(registry, "agent-split");
        _grantExact(alice, split, _one(_scope("goals.career", PERM_CREATE, 0)), 0);
        _grantExact(alice, split, _one(_scope("goals.career", PERM_READ, PROV_ALLOW_INFERENCE)), 0);
        ContextRegistry.ContextInput memory input =
            _contextInput(alice.owner, split.agentId, "goals.career", "split-inferred", GOAL, SOURCE_AGENT_INFERRED);
        _expectSubmitRevert(split.signer, alice.owner, input, abi.encodeWithSelector(ProvenanceForbidden.selector));
    }

    /// @dev §15 "imported/attested without evidence".
    function test_importedAndAttestedNeedEvidenceAndPolicyBits() public {
        TestAgent memory importer = _register(registry, "agent-import");
        _grantExact(alice, importer, _one(_scope("goals.career", PERM_CREATE, PROV_ALLOW_IMPORTED)), 0);

        ContextRegistry.ContextInput memory noEvidence =
            _contextInput(alice.owner, importer.agentId, "goals.career", "imp-none", FACT, SOURCE_IMPORTED);
        _expectSubmitRevert(importer.signer, alice.owner, noEvidence, abi.encodeWithSelector(ProvenanceForbidden.selector));

        ContextRegistry.ContextInput memory imported =
            _contextInput(alice.owner, importer.agentId, "goals.career", "imp-ok", FACT, SOURCE_IMPORTED);
        imported.evidenceCommitment = keccak256("evidence refs");
        _submit(importer.signer, alice.owner, imported);

        ContextRegistry.ContextInput memory attested =
            _contextInput(alice.owner, importer.agentId, "goals.career", "att", FACT, SOURCE_EXTERNAL_ATTESTATION);
        attested.evidenceCommitment = keccak256("evidence refs");
        _expectSubmitRevert(importer.signer, alice.owner, attested, abi.encodeWithSelector(ProvenanceForbidden.selector));

        ContextRegistry.ContextInput memory ownerImport =
            _contextInput(alice.owner, bytes32(0), "goals.career", "owner-imp", FACT, SOURCE_IMPORTED);
        _expectSubmitRevert(alice.owner, alice.owner, ownerImport, abi.encodeWithSelector(ProvenanceForbidden.selector));
        ownerImport.evidenceCommitment = keccak256("evidence refs");
        _submit(alice.owner, alice.owner, ownerImport);
    }

    // ---------------------------------------------------------------- evidence and record shape (§11.7)

    function test_evidenceRecordsAreImmutableArtifacts() public {
        ContextRegistry.ContextInput memory evidence = _evidenceInput(alice.owner, bytes32(0), "goals.career", "cv-upload");
        vm.expectEmit(address(contexts));
        emit ContextRegistry.EvidenceRegistered(alice.owner, evidence.namespaceId, evidence.contextId, bytes32(0), evidence.manifestHash);
        bytes32 evidenceId = _submit(alice.owner, alice.owner, evidence);

        ContextRegistry.ContextRecord memory record = contexts.getRecord(evidenceId);
        assertEq(record.lineageId, bytes32(0));
        assertEq(record.parentId, bytes32(0));
        assertEq(contexts.latest(evidenceId), bytes32(0), "evidence has no lineage head");

        ContextRegistry.ContextInput memory agentEvidence =
            _evidenceInput(alice.owner, creatorC.agentId, "goals.career", "c-evidence");
        _submit(creatorC.signer, alice.owner, agentEvidence);
        ContextRegistry.ContextInput memory deniedEvidence =
            _evidenceInput(alice.owner, readerA.agentId, "goals.career", "a-evidence");
        _expectSubmitRevert(readerA.signer, alice.owner, deniedEvidence, abi.encodeWithSelector(CapabilityDenied.selector));
    }

    function test_recordShapeRules() public {
        ContextRegistry.ContextInput memory input =
            _evidenceInput(alice.owner, bytes32(0), "goals.career", "shape-evidence-kind");
        input.kind = GOAL;
        _expectSubmitRevert(alice.owner, alice.owner, input, abi.encodeWithSelector(ContextRegistry.InvalidRecord.selector, input.contextId));

        input = _evidenceInput(alice.owner, bytes32(0), "goals.career", "shape-evidence-anchor");
        input.lineagePolicy = LINEAGE_OWNER_CONTROLLED;
        _expectSubmitRevert(alice.owner, alice.owner, input, abi.encodeWithSelector(ContextRegistry.InvalidRecord.selector, input.contextId));

        input = _evidenceInput(alice.owner, bytes32(0), "goals.career", "shape-evidence-parent");
        input.expectedParentId = keccak256("parent");
        _expectSubmitRevert(alice.owner, alice.owner, input, abi.encodeWithSelector(ContextRegistry.InvalidRecord.selector, input.contextId));

        input = _contextInput(alice.owner, bytes32(0), "goals.career", "shape-kind-none", KIND_NONE, SOURCE_USER_ASSERTED);
        _expectSubmitRevert(alice.owner, alice.owner, input, abi.encodeWithSelector(ContextRegistry.InvalidRecord.selector, input.contextId));

        input = _contextInput(alice.owner, bytes32(0), "goals.career", "shape-source-none", GOAL, SOURCE_NONE);
        _expectSubmitRevert(alice.owner, alice.owner, input, abi.encodeWithSelector(ContextRegistry.InvalidRecord.selector, input.contextId));

        input = _contextInput(alice.owner, bytes32(0), "goals.career", "shape-enum", 9, SOURCE_USER_ASSERTED);
        _expectSubmitRevert(alice.owner, alice.owner, input, abi.encodeWithSelector(ContextRegistry.InvalidRecord.selector, input.contextId));

        input = _contextInput(alice.owner, bytes32(0), "goals.career", "shape-manifest", GOAL, SOURCE_USER_ASSERTED);
        input.manifestHash = bytes32(0);
        _expectSubmitRevert(alice.owner, alice.owner, input, abi.encodeWithSelector(ContextRegistry.InvalidRecord.selector, input.contextId));
    }

    // ---------------------------------------------------------------- concurrency (§3.2)

    /// @dev §15 "independent roots/lineages created concurrently": no global nonce or lock.
    function test_independentRootsInOneBlockAndOneBatch() public {
        _submit(alice.owner, alice.owner, _contextInput(alice.owner, bytes32(0), "goals.career", "par-1", GOAL, SOURCE_USER_ASSERTED));
        _submit(
            creatorC.signer,
            alice.owner,
            _contextInput(alice.owner, creatorC.agentId, "goals.career", "par-2", GOAL, SOURCE_AGENT_INFERRED)
        );
        ContextRegistry.ContextInput[] memory inputs = new ContextRegistry.ContextInput[](2);
        inputs[0] = _contextInput(alice.owner, bytes32(0), "goals.career", "par-3", GOAL, SOURCE_USER_ASSERTED);
        inputs[1] = _contextInput(alice.owner, bytes32(0), "goals.career", "par-4", GOAL, SOURCE_USER_ASSERTED);
        vm.prank(alice.owner);
        bytes32[] memory ids = contexts.register(alice.owner, inputs);
        assertEq(contexts.latest(ids[0]), ids[0]);
        assertEq(contexts.latest(ids[1]), ids[1]);
    }
}
