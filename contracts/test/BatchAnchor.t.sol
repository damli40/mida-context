// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {
    KIND_NONE,
    PERM_CREATE,
    PERM_READ,
    PERM_SUPERSEDE_ANY,
    PERM_SUPERSEDE_OWN,
    PROV_ALLOW_INFERENCE,
    SOURCE_IMPORTED
} from "../src/MidaTypes.sol";
import {BatchAnchor} from "../src/BatchAnchor.sol";
import {BatchMerkle} from "../src/BatchMerkle.sol";
import {Revocations} from "../src/Revocations.sol";
import {BatchFixtures} from "./utils/BatchFixtures.sol";

/// @notice Plan Task 2: every accept/reject rule, duplicates, idempotence and the accepted-only root.
///         Reject reasons: 1 BAD_SIGNER, 2 BAD_SHAPE, 3 BAD_AREA, 4 BAD_EPOCH, 5 NO_AUTHORITY,
///         6 ALREADY_ANCHORED, 7 STALE_PARENT.
contract BatchAnchorTest is BatchFixtures {
    TestOwner internal alice;
    TestAgent internal writer;
    TestAgent internal other;
    TestAgent internal third;
    bytes32 internal career;
    bytes32 internal capWriter;
    bytes32 internal capOther;

    function setUp() public {
        _deployAnchor();
        alice = _ownerWithKey("alice");
        writer = _register(registry, "agent-w");
        other = _register(registry, "agent-o");
        third = _register(registry, "agent-t");
        career = _ns("goals.career");
        _initEpoch(alice, "goals.career");
        capWriter = _grantExact(
            alice, writer, _one(_scope("goals.career", PERM_CREATE | PERM_SUPERSEDE_OWN, PROV_ALLOW_INFERENCE)), 0
        )[0];
        capOther = _grantExact(alice, other, _one(_scope("goals.career", PERM_READ, 0)), 0)[0];
        _grantExact(alice, third, _one(_scope("goals.career", PERM_SUPERSEDE_OWN, PROV_ALLOW_INFERENCE)), 0);
    }

    function _leaf(BatchAnchor.SignedSave memory s, bytes32 contextId, bytes32 agentId, bytes32 lineageId, uint32 version)
        internal
        pure
        returns (bytes32)
    {
        return
            keccak256(abi.encode(string("MIDA_BATCH_LEAF_V1"), contextId, agentId, lineageId, version, _structHash(s)));
    }

    function _headCommitFor(bytes32 contextId, address owner, bytes32 namespaceId, bytes32 rootAuthor, uint32 version)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(contextId, owner, namespaceId, rootAuthor, version));
    }

    function _expectAnchored(
        bytes32 contextId,
        bytes32 batchId,
        bytes32 lineageId,
        uint32 version,
        bytes32 author,
        uint32 position,
        bytes32 leaf
    ) internal {
        vm.expectEmit(true, true, true, true, address(anchor));
        emit BatchAnchor.SaveAnchored(alice.owner, contextId, batchId, career, lineageId, version, author, position, leaf);
    }

    function _expectRejected(bytes32 batchId, uint32 index, uint8 reason) internal {
        vm.expectEmit(true, false, false, true, address(anchor));
        emit BatchAnchor.SaveRejected(batchId, index, reason);
    }

    function _saves(BatchAnchor.SignedSave memory a, BatchAnchor.SignedSave memory b)
        internal
        pure
        returns (BatchAnchor.SignedSave[] memory list)
    {
        list = new BatchAnchor.SignedSave[](2);
        list[0] = a;
        list[1] = b;
    }

    // ---------------------------------------------------------------- accept

    function test_acceptsRootAndStoresOneRoot() public {
        BatchAnchor.SignedSave memory s = _rootSave(alice.owner, "goals.career", "cp-1", writer.signerKey);
        bytes32 id = keccak256("batch-1");
        bytes32 contextId = _contextIdOf(s, writer.agentId);
        bytes32 leaf = _leaf(s, contextId, writer.agentId, contextId, 1);
        _expectAnchored(contextId, id, contextId, 1, writer.agentId, 0, leaf);
        (bytes32 root, uint32 accepted) = anchor.submitBatch(id, _oneSave(s));
        assertEq(accepted, 1);
        assertEq(root, leaf);
        (bytes32 stored,, uint32 count) = anchor.batchOf(id);
        assertEq(stored, leaf);
        assertEq(count, 1);
        assertEq(anchor.headCommitOf(contextId), _headCommitFor(contextId, alice.owner, s.namespaceId, writer.agentId, 1));
        assertTrue(anchor.hasBatchedSaves(alice.owner));
    }

    // ---------------------------------------------------------------- signer (reason 1)

    function test_rejectsBadSignature() public {
        (, uint256 strangerKey) = makeAddrAndKey("stranger");
        BatchAnchor.SignedSave memory s =
            _signSave(_unsignedRoot(alice.owner, _ns("goals.career"), "cp-stranger"), strangerKey);
        bytes32 id = keccak256("batch-badsig");
        _expectRejected(id, 0, 1);
        (bytes32 root, uint32 accepted) = anchor.submitBatch(id, _oneSave(s));
        assertEq(accepted, 0);
        assertEq(root, bytes32(0));
        assertFalse(anchor.hasBatchedSaves(alice.owner));
    }

    function test_rejectsMalformedSignature() public {
        BatchAnchor.SignedSave memory s = _unsignedRoot(alice.owner, _ns("goals.career"), "cp-malformed");
        s.signature = new bytes(64);
        bytes32 id = keccak256("batch-malformed");
        _expectRejected(id, 0, 1);
        (bytes32 root, uint32 accepted) = anchor.submitBatch(id, _oneSave(s));
        assertEq(accepted, 0);
        assertEq(root, bytes32(0));
    }

    // ---------------------------------------------------------------- shape (reason 2)

    function test_rejectsWrongKindOrSource() public {
        BatchAnchor.SignedSave memory badKind = _unsignedRoot(alice.owner, _ns("goals.career"), "cp-kind0");
        badKind.kind = KIND_NONE;
        badKind = _signSave(badKind, writer.signerKey);
        bytes32 idKind = keccak256("batch-kind");
        _expectRejected(idKind, 0, 2);
        (bytes32 rootKind, uint32 acceptedKind) = anchor.submitBatch(idKind, _oneSave(badKind));
        assertEq(acceptedKind, 0);
        assertEq(rootKind, bytes32(0));

        BatchAnchor.SignedSave memory badSource = _unsignedRoot(alice.owner, _ns("goals.career"), "cp-src");
        badSource.provenanceSource = SOURCE_IMPORTED;
        badSource = _signSave(badSource, writer.signerKey);
        bytes32 idSource = keccak256("batch-source");
        _expectRejected(idSource, 0, 2);
        (bytes32 rootSource, uint32 acceptedSource) = anchor.submitBatch(idSource, _oneSave(badSource));
        assertEq(acceptedSource, 0);
        assertEq(rootSource, bytes32(0));
    }

    // ---------------------------------------------------------------- area (reason 3)

    function test_rejectsUnknownArea() public {
        BatchAnchor.SignedSave memory s = _unsignedRoot(alice.owner, keccak256("nope"), "cp-area");
        s = _signSave(s, writer.signerKey);
        bytes32 id = keccak256("batch-area");
        _expectRejected(id, 0, 3);
        (bytes32 root, uint32 accepted) = anchor.submitBatch(id, _oneSave(s));
        assertEq(accepted, 0);
        assertEq(root, bytes32(0));
    }

    // ---------------------------------------------------------------- epoch (reason 4)

    function test_rejectsStaleReadEpoch() public {
        BatchAnchor.SignedSave memory s = _rootSave(alice.owner, "goals.career", "cp-old-epoch", writer.signerKey);
        // Rotating the epoch by revoking a DIFFERENT agent's READ capability leaves writer's authority
        // live — the save is reported BAD_EPOCH, which only a still-authorized save can be.
        vm.prank(alice.owner);
        registry.revokeAndRotate(capOther, _epochKey(alice.owner, "goals.career", 2));
        bytes32 id = keccak256("batch-epoch");
        _expectRejected(id, 0, 4);
        (bytes32 root, uint32 accepted) = anchor.submitBatch(id, _oneSave(s));
        assertEq(accepted, 0);
        assertEq(root, bytes32(0));
    }

    // ---------------------------------------------------------------- authority (reason 5)

    function test_rejectsNoGrant() public {
        BatchAnchor.SignedSave memory s = _rootSave(alice.owner, "goals.career", "cp-x", other.signerKey);
        bytes32 id = keccak256("batch-x");
        vm.expectEmit(true, false, false, true, address(anchor));
        emit BatchAnchor.SaveRejected(id, 0, 5);
        (bytes32 root, uint32 accepted) = anchor.submitBatch(id, _oneSave(s));
        assertEq(accepted, 0);
        assertEq(root, bytes32(0));
        assertFalse(anchor.hasBatchedSaves(alice.owner));
    }

    function test_rejectsRevokedMidBatch() public {
        BatchAnchor.SignedSave memory s1 = _rootSave(alice.owner, "goals.career", "cp-r1", writer.signerKey);
        BatchAnchor.SignedSave memory s2 = _rootSave(alice.owner, "goals.career", "cp-r2", writer.signerKey);
        // The real revoke path: writer also holds READ, so ending its authority rotates the read epoch
        // in the same call. Each save then carries a dead capability AND the old epoch — authority is
        // reported first, so the reason is NO_AUTHORITY, not BAD_EPOCH.
        _grantExact(alice, writer, _one(_scope("goals.career", PERM_READ, 0)), 0);
        Revocations.EpochRotation[] memory rotations = new Revocations.EpochRotation[](1);
        rotations[0] = Revocations.EpochRotation({
            namespaceId: career,
            newEpochPublicKey: _epochKey(alice.owner, "goals.career", 2)
        });
        vm.prank(alice.owner);
        registry.revokeAgentAndRotate(writer.agentId, rotations);
        bytes32 id = keccak256("batch-revoked");
        _expectRejected(id, 0, 5);
        _expectRejected(id, 1, 5);
        (bytes32 root, uint32 accepted) = anchor.submitBatch(id, _saves(s1, s2));
        assertEq(accepted, 0);
        assertEq(root, bytes32(0));
        (, uint64 blockNumber,) = anchor.batchOf(id);
        assertTrue(blockNumber != 0);
    }

    function test_rejectsExpiredGrant() public {
        TestAgent memory temp = _register(registry, "agent-exp");
        uint64 expiry = uint64(block.timestamp + 1 hours);
        _grantExact(alice, temp, _one(_scope("goals.career", PERM_CREATE, PROV_ALLOW_INFERENCE)), expiry);
        BatchAnchor.SignedSave memory s = _rootSave(alice.owner, "goals.career", "cp-exp", temp.signerKey);
        vm.warp(expiry);
        bytes32 id = keccak256("batch-expired");
        _expectRejected(id, 0, 5);
        (bytes32 root, uint32 accepted) = anchor.submitBatch(id, _oneSave(s));
        assertEq(accepted, 0);
        assertEq(root, bytes32(0));
    }

    // ---------------------------------------------------------------- duplicates (reason 6)

    function test_duplicateRootSameBatch() public {
        BatchAnchor.SignedSave memory s = _rootSave(alice.owner, "goals.career", "cp-dup", writer.signerKey);
        bytes32 id = keccak256("batch-dup-same");
        bytes32 contextId = _contextIdOf(s, writer.agentId);
        bytes32 leaf = _leaf(s, contextId, writer.agentId, contextId, 1);
        _expectAnchored(contextId, id, contextId, 1, writer.agentId, 0, leaf);
        _expectRejected(id, 1, 6);
        (bytes32 root, uint32 accepted) = anchor.submitBatch(id, _saves(s, s));
        assertEq(accepted, 1);
        assertEq(root, leaf);
    }

    function test_duplicateRootAcrossBatches() public {
        BatchAnchor.SignedSave memory s = _rootSave(alice.owner, "goals.career", "cp-dup2", writer.signerKey);
        anchor.submitBatch(keccak256("batch-a"), _oneSave(s));
        bytes32 idB = keccak256("batch-b");
        _expectRejected(idB, 0, 6);
        (bytes32 rootB, uint32 acceptedB) = anchor.submitBatch(idB, _oneSave(s));
        assertEq(acceptedB, 0);
        assertEq(rootB, bytes32(0));
    }

    // ---------------------------------------------------------------- lineage and replacement

    function test_nonceReuseInLineageCannotCollide() public {
        BatchAnchor.SignedSave memory r = _rootSave(alice.owner, "goals.career", "n", writer.signerKey);
        bytes32 rId = _contextIdOf(r, writer.agentId);
        BatchAnchor.SignedSave memory c1 = _childOf(r, writer.agentId, 1, rId, writer.agentId, "n2", writer.signerKey);
        bytes32 c1Id = _contextIdOf(c1, writer.agentId);
        // C2 reuses R's nonce; its parent is C1, so the parent-bound id cannot collide with R.
        BatchAnchor.SignedSave memory c2 = _childOf(c1, writer.agentId, 2, rId, writer.agentId, "n", writer.signerKey);
        bytes32 c2Id = _contextIdOf(c2, writer.agentId);
        assertEq(r.objectNonce, c2.objectNonce);

        bytes32 id = keccak256("batch-lineage");
        _expectAnchored(rId, id, rId, 1, writer.agentId, 0, _leaf(r, rId, writer.agentId, rId, 1));
        _expectAnchored(c1Id, id, rId, 2, writer.agentId, 1, _leaf(c1, c1Id, writer.agentId, rId, 2));
        _expectAnchored(c2Id, id, rId, 3, writer.agentId, 2, _leaf(c2, c2Id, writer.agentId, rId, 3));
        BatchAnchor.SignedSave[] memory list = new BatchAnchor.SignedSave[](3);
        list[0] = r;
        list[1] = c1;
        list[2] = c2;
        (, uint32 accepted) = anchor.submitBatch(id, list);
        assertEq(accepted, 3);
        assertTrue(rId != c1Id && c1Id != c2Id && rId != c2Id);
        assertEq(anchor.headCommitOf(rId), _headCommitFor(c2Id, alice.owner, career, writer.agentId, 3));
    }

    function test_replacementAccepted() public {
        BatchAnchor.SignedSave memory r = _rootSave(alice.owner, "goals.career", "cp-root", writer.signerKey);
        bytes32 rId = _contextIdOf(r, writer.agentId);
        anchor.submitBatch(keccak256("batch-r"), _oneSave(r));

        BatchAnchor.SignedSave memory c1 = _childOf(r, writer.agentId, 1, rId, writer.agentId, "c1", writer.signerKey);
        bytes32 c1Id = _contextIdOf(c1, writer.agentId);
        bytes32 id = keccak256("batch-c1");
        bytes32 leaf = _leaf(c1, c1Id, writer.agentId, rId, 2);
        _expectAnchored(c1Id, id, rId, 2, writer.agentId, 0, leaf);
        (bytes32 root, uint32 accepted) = anchor.submitBatch(id, _oneSave(c1));
        assertEq(accepted, 1);
        assertEq(root, leaf);
        assertEq(anchor.headCommitOf(rId), _headCommitFor(c1Id, alice.owner, career, writer.agentId, 2));
    }

    function test_replacementStaleParent() public {
        BatchAnchor.SignedSave memory r = _rootSave(alice.owner, "goals.career", "cp-r", writer.signerKey);
        bytes32 rId = _contextIdOf(r, writer.agentId);
        BatchAnchor.SignedSave memory c1 = _childOf(r, writer.agentId, 1, rId, writer.agentId, "c1", writer.signerKey);
        anchor.submitBatch(keccak256("batch-rc1"), _saves(r, c1));

        // A second child of R: the head already moved to C1, so the parent commit no longer matches.
        BatchAnchor.SignedSave memory c2 = _childOf(r, writer.agentId, 1, rId, writer.agentId, "c2", writer.signerKey);
        bytes32 id = keccak256("batch-c2");
        _expectRejected(id, 0, 7);
        (bytes32 root, uint32 accepted) = anchor.submitBatch(id, _oneSave(c2));
        assertEq(accepted, 0);
        assertEq(root, bytes32(0));
    }

    function test_replacementWrongVersionOrOwner() public {
        BatchAnchor.SignedSave memory r = _rootSave(alice.owner, "goals.career", "cp-r", writer.signerKey);
        bytes32 rId = _contextIdOf(r, writer.agentId);
        anchor.submitBatch(keccak256("batch-r2"), _oneSave(r));

        BatchAnchor.SignedSave memory wrongVersion =
            _childOf(r, writer.agentId, 2, rId, writer.agentId, "cv", writer.signerKey);
        bytes32 idV = keccak256("batch-wrongv");
        _expectRejected(idV, 0, 7);
        (bytes32 rootV, uint32 acceptedV) = anchor.submitBatch(idV, _oneSave(wrongVersion));
        assertEq(acceptedV, 0);
        assertEq(rootV, bytes32(0));

        // Same lineage but claimed for another owner: authority is checked first, so bob grants the
        // writer the same rights it holds under alice — then the stored head commit, which binds
        // alice, is what rejects the claim.
        TestOwner memory bob = _ownerWithKey("bob");
        _initEpoch(bob, "goals.career");
        _grantExact(bob, writer, _one(_scope("goals.career", PERM_CREATE | PERM_SUPERSEDE_OWN, PROV_ALLOW_INFERENCE)), 0);
        BatchAnchor.SignedSave memory wrongOwner = _unsignedRoot(bob.owner, _ns("goals.career"), "cb");
        wrongOwner.parentId = rId;
        wrongOwner.lineageId = rId;
        wrongOwner.parentVersion = 1;
        wrongOwner.rootAuthor = writer.agentId;
        wrongOwner = _signSave(wrongOwner, writer.signerKey);
        bytes32 idO = keccak256("batch-wrongo");
        _expectRejected(idO, 0, 7);
        (bytes32 rootO, uint32 acceptedO) = anchor.submitBatch(idO, _oneSave(wrongOwner));
        assertEq(acceptedO, 0);
        assertEq(rootO, bytes32(0));
    }

    function test_replacementOfOtherAuthorNeedsAny() public {
        BatchAnchor.SignedSave memory r = _rootSave(alice.owner, "goals.career", "cp-r", writer.signerKey);
        bytes32 rId = _contextIdOf(r, writer.agentId);
        anchor.submitBatch(keccak256("batch-r3"), _oneSave(r));

        // third holds SUPERSEDE_OWN only; the root author is writer, so only SUPERSEDE_ANY can pass.
        BatchAnchor.SignedSave memory c = _childOf(r, writer.agentId, 1, rId, writer.agentId, "c-other", third.signerKey);
        bytes32 id = keccak256("batch-third-denied");
        _expectRejected(id, 0, 5);
        (bytes32 root, uint32 accepted) = anchor.submitBatch(id, _oneSave(c));
        assertEq(accepted, 0);
        assertEq(root, bytes32(0));

        _grantExact(alice, third, _one(_scope("goals.career", PERM_SUPERSEDE_ANY, PROV_ALLOW_INFERENCE)), 0);
        bytes32 id2 = keccak256("batch-third-ok");
        bytes32 cId = _contextIdOf(c, third.agentId);
        bytes32 leaf = _leaf(c, cId, third.agentId, rId, 2);
        _expectAnchored(cId, id2, rId, 2, third.agentId, 0, leaf);
        (bytes32 root2, uint32 accepted2) = anchor.submitBatch(id2, _oneSave(c));
        assertEq(accepted2, 1);
        assertEq(root2, leaf);
        assertEq(anchor.headCommitOf(rId), _headCommitFor(cId, alice.owner, career, writer.agentId, 2));
    }

    // ---------------------------------------------------------------- the root covers accepted saves only

    function test_partialBatchRootIsAcceptedOnly() public {
        (, uint256 strangerKey) = makeAddrAndKey("stranger");
        BatchAnchor.SignedSave memory s0 = _rootSave(alice.owner, "goals.career", "p0", writer.signerKey);
        BatchAnchor.SignedSave memory s1 = _signSave(_unsignedRoot(alice.owner, _ns("goals.career"), "p1"), strangerKey);
        BatchAnchor.SignedSave memory s2 = _rootSave(alice.owner, "goals.career", "p2", writer.signerKey);
        BatchAnchor.SignedSave memory s3 = _unsignedRoot(alice.owner, _ns("goals.career"), "p3");
        s3.kind = KIND_NONE;
        s3 = _signSave(s3, writer.signerKey);
        BatchAnchor.SignedSave memory s4 = _rootSave(alice.owner, "goals.career", "p4", writer.signerKey);

        bytes32 id = keccak256("batch-partial");
        bytes32 id0 = _contextIdOf(s0, writer.agentId);
        bytes32 id2 = _contextIdOf(s2, writer.agentId);
        bytes32 id4 = _contextIdOf(s4, writer.agentId);
        bytes32 leaf0 = _leaf(s0, id0, writer.agentId, id0, 1);
        bytes32 leaf2 = _leaf(s2, id2, writer.agentId, id2, 1);
        bytes32 leaf4 = _leaf(s4, id4, writer.agentId, id4, 1);

        _expectAnchored(id0, id, id0, 1, writer.agentId, 0, leaf0);
        _expectRejected(id, 1, 1);
        _expectAnchored(id2, id, id2, 1, writer.agentId, 1, leaf2);
        _expectRejected(id, 3, 2);
        _expectAnchored(id4, id, id4, 1, writer.agentId, 2, leaf4);

        BatchAnchor.SignedSave[] memory list = new BatchAnchor.SignedSave[](5);
        list[0] = s0;
        list[1] = s1;
        list[2] = s2;
        list[3] = s3;
        list[4] = s4;
        (bytes32 root, uint32 accepted) = anchor.submitBatch(id, list);
        assertEq(accepted, 3);

        bytes32[] memory leaves = new bytes32[](3);
        leaves[0] = leaf0;
        leaves[1] = leaf2;
        leaves[2] = leaf4;
        assertEq(root, BatchMerkle.root(leaves, 3));
        (bytes32 stored,, uint32 count) = anchor.batchOf(id);
        assertEq(stored, root);
        assertEq(count, 3);
    }

    // ---------------------------------------------------------------- batch id and size guards

    function test_batchIdReuseReverts() public {
        BatchAnchor.SignedSave memory s = _rootSave(alice.owner, "goals.career", "cp-reuse", writer.signerKey);
        bytes32 id = keccak256("batch-reuse");
        anchor.submitBatch(id, _oneSave(s));
        vm.expectRevert(abi.encodeWithSelector(BatchAnchor.BatchExists.selector, id));
        anchor.submitBatch(id, _oneSave(s));
    }

    function test_emptyAndOversize() public {
        vm.expectRevert(BatchAnchor.EmptyBatch.selector);
        anchor.submitBatch(keccak256("batch-empty"), new BatchAnchor.SignedSave[](0));

        BatchAnchor.SignedSave[] memory tooMany = new BatchAnchor.SignedSave[](anchor.MAX_BATCH() + 1);
        vm.expectRevert(abi.encodeWithSelector(BatchAnchor.BatchTooLarge.selector, anchor.MAX_BATCH() + 1));
        anchor.submitBatch(keccak256("batch-big"), tooMany);
    }

    function test_allRejectedSpendsId() public {
        BatchAnchor.SignedSave[] memory saves = new BatchAnchor.SignedSave[](2);
        saves[0] = _rootSave(alice.owner, "goals.career", "x1", other.signerKey);
        saves[1] = _rootSave(alice.owner, "goals.career", "x2", other.signerKey);
        bytes32 id = keccak256("batch-allbad");
        _expectRejected(id, 0, 5);
        _expectRejected(id, 1, 5);
        (bytes32 root, uint32 accepted) = anchor.submitBatch(id, saves);
        assertEq(accepted, 0);
        assertEq(root, bytes32(0));
        (bytes32 stored, uint64 blockNumber, uint32 count) = anchor.batchOf(id);
        assertEq(stored, bytes32(0));
        assertEq(count, 0);
        assertTrue(blockNumber != 0);
        vm.expectRevert(abi.encodeWithSelector(BatchAnchor.BatchExists.selector, id));
        anchor.submitBatch(id, saves);
    }

    function test_anyoneCanSubmitButCannotForge() public {
        BatchAnchor.SignedSave memory s = _rootSave(alice.owner, "goals.career", "cp-courier", writer.signerKey);
        bytes32 id = keccak256("batch-courier");
        bytes32 contextId = _contextIdOf(s, writer.agentId);
        bytes32 leaf = _leaf(s, contextId, writer.agentId, contextId, 1);
        _expectAnchored(contextId, id, contextId, 1, writer.agentId, 0, leaf);
        vm.prank(makeAddr("courier"));
        (bytes32 root, uint32 accepted) = anchor.submitBatch(id, _oneSave(s));
        assertEq(accepted, 1);
        assertEq(root, leaf);
    }
}
