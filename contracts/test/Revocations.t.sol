// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {
    GrantScope,
    PERM_CREATE,
    PERM_READ,
    PERM_SUPERSEDE_OWN,
    PROV_ALLOW_INFERENCE
} from "../src/MidaTypes.sol";
import {CapabilityStore} from "../src/CapabilityStore.sol";
import {ReadEpochs} from "../src/ReadEpochs.sol";
import {Revocations} from "../src/Revocations.sol";
import {GrantFixtures} from "./utils/GrantFixtures.sol";

/// @notice §10.5 exact authorization, §10.6 revocation with rotation, §7.3 expiry, and §15 CREATE, READ,
///         Revocation, Expiry and Epoch rows.
contract RevocationsTest is GrantFixtures {
    TestOwner internal alice;
    TestAgent internal readerA;
    TestAgent internal readerD;
    TestAgent internal creatorC;
    bytes32 internal career;
    bytes32 internal capA;
    bytes32 internal capD;
    bytes32 internal capC;

    function setUp() public {
        _deployRegistry();
        alice = _ownerWithKey("alice");
        readerA = _register(registry, "agent-a");
        readerD = _register(registry, "agent-d");
        creatorC = _register(registry, "agent-c");
        career = _ns("goals.career");
        _initEpoch(alice, "goals.career");
        capA = _grantExact(alice, readerA, _one(_scope("goals.career", PERM_READ, 0)), 0)[0];
        capD = _grantExact(alice, readerD, _one(_scope("goals.career", PERM_READ, 0)), 0)[0];
        capC = _grantExact(alice, creatorC, _one(_scope("goals.career", PERM_CREATE, PROV_ALLOW_INFERENCE)), 0)[0];
    }

    function _rotation(string memory name, uint64 epoch) internal view returns (Revocations.EpochRotation memory) {
        return Revocations.EpochRotation(_ns(name), _epochKey(alice.owner, name, epoch));
    }

    // ---------------------------------------------------------------- exact authorization (§10.5)

    /// @dev §15 "CREATE-only agent reads existing object": capability denied.
    function test_isAuthorizedIsExact() public view {
        assertTrue(registry.isAuthorized(alice.owner, readerA.agentId, career, PERM_READ));
        assertFalse(registry.isAuthorized(alice.owner, readerA.agentId, career, PERM_CREATE));
        assertFalse(registry.isAuthorized(alice.owner, readerA.agentId, _ns("goals"), PERM_READ), "parent not implied");
        assertFalse(registry.isAuthorized(alice.owner, readerA.agentId, _ns("goals.learning"), PERM_READ), "sibling");
        assertTrue(registry.isAuthorized(alice.owner, creatorC.agentId, career, PERM_CREATE));
        assertFalse(registry.isAuthorized(alice.owner, creatorC.agentId, career, PERM_READ), "CREATE does not imply READ");
        assertFalse(registry.isAuthorized(address(0xB0B), readerA.agentId, career, PERM_READ), "other owner");
        assertFalse(registry.isAuthorized(alice.owner, keccak256("agent-b"), career, PERM_READ), "no grant");
        assertFalse(registry.isAuthorized(alice.owner, _ns("goals.side"), career, PERM_READ), "unknown agent id");
        assertFalse(registry.isAuthorized(alice.owner, readerA.agentId, _ns("goals.side"), PERM_READ), "unknown namespace");
    }

    function test_zeroPermissionNeverAuthorizes() public view {
        assertFalse(registry.isAuthorized(alice.owner, readerA.agentId, career, 0));
        assertFalse(registry.hasAuthority(alice.owner, creatorC.agentId, career, 0, 0));
    }

    function test_hasAuthorityRequiresBitsInOneCapability() public {
        TestAgent memory split = _register(registry, "agent-split");
        _grantExact(alice, split, _one(_scope("goals.career", PERM_CREATE, 0)), 0);
        _grantExact(alice, split, _one(_scope("goals.career", PERM_READ, PROV_ALLOW_INFERENCE)), 0);
        assertTrue(registry.hasAuthority(alice.owner, split.agentId, career, PERM_CREATE, 0));
        assertTrue(registry.hasAuthority(alice.owner, split.agentId, career, PERM_READ, PROV_ALLOW_INFERENCE));
        assertFalse(registry.hasAuthority(alice.owner, split.agentId, career, PERM_CREATE, PROV_ALLOW_INFERENCE));
        assertFalse(registry.hasAuthority(alice.owner, split.agentId, career, PERM_CREATE | PERM_READ, 0));
        assertTrue(registry.hasAuthority(alice.owner, creatorC.agentId, career, PERM_CREATE, PROV_ALLOW_INFERENCE));
    }

    // ---------------------------------------------------------------- revoke without rotation

    function test_revokeRejectsLiveReadCapability() public {
        vm.prank(alice.owner);
        vm.expectRevert(abi.encodeWithSelector(Revocations.ReadRequiresRotation.selector, capA));
        registry.revoke(capA);
    }

    function test_revokeCreateOnlyCapability() public {
        vm.expectEmit(address(registry));
        emit Revocations.CapabilityRevoked(alice.owner, creatorC.agentId, career, capC);
        vm.prank(alice.owner);
        registry.revoke(capC);
        assertFalse(registry.isAuthorized(alice.owner, creatorC.agentId, career, PERM_CREATE));
        assertEq(registry.requiredReadEpoch(alice.owner, career), 1, "CREATE revocation needs no rotation");

        vm.prank(alice.owner);
        vm.expectRevert(abi.encodeWithSelector(Revocations.CapabilityAlreadyRevoked.selector, capC));
        registry.revoke(capC);
    }

    function test_onlyCapabilityOwnerCanRevoke() public {
        address bob = makeAddr("bob");
        vm.startPrank(bob);
        vm.expectRevert(abi.encodeWithSelector(Revocations.NotCapabilityOwner.selector, capC));
        registry.revoke(capC);
        vm.expectRevert(abi.encodeWithSelector(Revocations.NotCapabilityOwner.selector, capA));
        registry.revokeAndRotate(capA, keccak256("key"));
        vm.expectRevert(abi.encodeWithSelector(CapabilityStore.CapabilityNotFound.selector, bytes32(uint256(1))));
        registry.revoke(bytes32(uint256(1)));
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- revokeAndRotate

    /// @dev §15 "revoke one reader", "write in old epoch after revoke", "remaining reader crosses an epoch rotation".
    function test_revokeAndRotateEndsReadAndAdvancesEpoch() public {
        bytes32 epoch2Key = _epochKey(alice.owner, "goals.career", 2);
        vm.expectEmit(address(registry));
        emit Revocations.CapabilityRevoked(alice.owner, readerA.agentId, career, capA);
        vm.expectEmit(address(registry));
        emit ReadEpochs.ReadEpochRequired(alice.owner, career, 2, 0);
        vm.expectEmit(address(registry));
        emit ReadEpochs.NamespaceEpochKeySet(alice.owner, career, 2, epoch2Key);
        vm.prank(alice.owner);
        registry.revokeAndRotate(capA, epoch2Key);

        assertFalse(registry.isAuthorized(alice.owner, readerA.agentId, career, PERM_READ));
        assertTrue(registry.isAuthorized(alice.owner, readerD.agentId, career, PERM_READ), "remaining reader");
        assertEq(registry.getCapability(capD).grantedAtReadEpoch, 1, "remaining reader keeps its capability");
        assertEq(registry.requiredReadEpoch(alice.owner, career), 2);
        assertEq(registry.epochPublicKey(alice.owner, career, 1), _epochKey(alice.owner, "goals.career", 1), "history kept");
        assertEq(registry.epochPublicKey(alice.owner, career, 2), epoch2Key);
        assertFalse(registry.isWriteEpochValid(alice.owner, career, 1), "old epoch closed");
        assertTrue(registry.isWriteEpochValid(alice.owner, career, 2));
    }

    function test_revokeAndRotateRejectsNonReadRevokedAndZeroKey() public {
        vm.startPrank(alice.owner);
        vm.expectRevert(abi.encodeWithSelector(Revocations.RotationNotApplicable.selector, capC));
        registry.revokeAndRotate(capC, keccak256("key"));
        vm.expectRevert(ReadEpochs.ZeroEpochKey.selector);
        registry.revokeAndRotate(capA, bytes32(0));
        registry.revokeAndRotate(capA, _epochKey(alice.owner, "goals.career", 2));
        vm.expectRevert(abi.encodeWithSelector(Revocations.CapabilityAlreadyRevoked.selector, capA));
        registry.revokeAndRotate(capA, _epochKey(alice.owner, "goals.career", 3));
        vm.stopPrank();
    }

    function test_rotationRecomputesDeadlineFromRemainingReaders() public {
        TestAgent memory shortReader = _register(registry, "agent-short");
        TestAgent memory longReader = _register(registry, "agent-long");
        uint64 inOneDay = uint64(block.timestamp + 1 days);
        uint64 inTwoDays = uint64(block.timestamp + 2 days);
        bytes32 shortCap = _grantExact(alice, shortReader, _one(_scope("goals.career", PERM_READ, 0)), inOneDay)[0];
        _grantExact(alice, longReader, _one(_scope("goals.career", PERM_READ, 0)), inTwoDays);
        assertEq(registry.writeDeadline(alice.owner, career), inOneDay);

        vm.prank(alice.owner);
        registry.revokeAndRotate(shortCap, _epochKey(alice.owner, "goals.career", 2));
        assertEq(registry.writeDeadline(alice.owner, career), inTwoDays);
    }

    // ---------------------------------------------------------------- agent-wide revocation

    /// @dev §15 "agent-wide revocation": every old capability epoch fails.
    function test_revokeAgentAndRotateInvalidatesEveryCapability() public {
        _initEpoch(alice, "profile.skills");
        bytes32 skillsCap = _grantExact(alice, readerA, _one(_scope("profile.skills", PERM_READ, 0)), 0)[0];
        bytes32 createCap = _grantExact(alice, readerA, _one(_scope("projects.current", PERM_CREATE, 0)), 0)[0];
        Revocations.EpochRotation[] memory rotations = new Revocations.EpochRotation[](2);
        rotations[0] = _rotation("profile.skills", 2);
        rotations[1] = _rotation("goals.career", 2);

        vm.expectEmit(address(registry));
        emit Revocations.AgentRevoked(alice.owner, readerA.agentId, 1);
        vm.prank(alice.owner);
        registry.revokeAgentAndRotate(readerA.agentId, rotations);

        assertFalse(registry.isCapabilityValid(capA));
        assertFalse(registry.isCapabilityValid(skillsCap));
        assertFalse(registry.isCapabilityValid(createCap));
        assertFalse(registry.getCapability(capA).revoked, "invalidated by agent epoch, not by flag");
        assertEq(registry.agentEpoch(alice.owner, readerA.agentId), 1);
        assertEq(registry.activeCapabilityIds(alice.owner, readerA.agentId).length, 0);
        assertEq(registry.requiredReadEpoch(alice.owner, career), 2);
        assertEq(registry.requiredReadEpoch(alice.owner, _ns("profile.skills")), 2);
        assertEq(registry.requiredReadEpoch(alice.owner, _ns("projects.current")), 1, "CREATE-only namespace untouched");
        assertTrue(registry.isAuthorized(alice.owner, readerD.agentId, career, PERM_READ));

        bytes32 regranted = _grantExact(alice, readerA, _one(_scope("goals.career", PERM_READ, 0)), 0)[0];
        assertEq(registry.getCapability(regranted).agentEpoch, 1);
        assertTrue(registry.isAuthorized(alice.owner, readerA.agentId, career, PERM_READ));
    }

    function test_revokeAgentAndRotateRequiresExactRotationSet() public {
        _initEpoch(alice, "profile.skills");
        _grantExact(alice, readerA, _one(_scope("profile.skills", PERM_READ, 0)), 0);
        bytes memory mismatch = abi.encodeWithSelector(Revocations.RotationSetMismatch.selector);

        Revocations.EpochRotation[] memory missing = new Revocations.EpochRotation[](1);
        missing[0] = _rotation("goals.career", 2);
        Revocations.EpochRotation[] memory duplicate = new Revocations.EpochRotation[](2);
        duplicate[0] = _rotation("goals.career", 2);
        duplicate[1] = _rotation("goals.career", 2);
        Revocations.EpochRotation[] memory wrong = new Revocations.EpochRotation[](2);
        wrong[0] = _rotation("goals.career", 2);
        wrong[1] = _rotation("projects.current", 2);
        Revocations.EpochRotation[] memory extra = new Revocations.EpochRotation[](3);
        extra[0] = _rotation("goals.career", 2);
        extra[1] = _rotation("profile.skills", 2);
        extra[2] = _rotation("projects.current", 2);

        vm.startPrank(alice.owner);
        vm.expectRevert(mismatch);
        registry.revokeAgentAndRotate(readerA.agentId, missing);
        vm.expectRevert(mismatch);
        registry.revokeAgentAndRotate(readerA.agentId, duplicate);
        vm.expectRevert(mismatch);
        registry.revokeAgentAndRotate(readerA.agentId, wrong);
        vm.expectRevert(mismatch);
        registry.revokeAgentAndRotate(readerA.agentId, extra);
        vm.stopPrank();

        assertTrue(registry.isCapabilityValid(capA), "every failed attempt rolled back");
        assertEq(registry.agentEpoch(alice.owner, readerA.agentId), 0);
    }

    function test_twoReadCapabilitiesOnOneNamespaceRotateOnce() public {
        _grantExact(alice, readerA, _one(_scope("goals.career", PERM_READ | PERM_SUPERSEDE_OWN, 0)), 0);
        Revocations.EpochRotation[] memory rotations = new Revocations.EpochRotation[](1);
        rotations[0] = _rotation("goals.career", 2);
        vm.prank(alice.owner);
        registry.revokeAgentAndRotate(readerA.agentId, rotations);
        assertEq(registry.requiredReadEpoch(alice.owner, career), 2);
    }

    function test_revokeAgentWithoutReadNeedsNoRotations() public {
        vm.prank(alice.owner);
        registry.revokeAgentAndRotate(creatorC.agentId, new Revocations.EpochRotation[](0));
        assertFalse(registry.isCapabilityValid(capC));
        assertEq(registry.requiredReadEpoch(alice.owner, career), 1);
    }

    // ---------------------------------------------------------------- expiry (§7.3)

    /// @dev §15 Expiry rows: authorization fails at expiry, writes fail at and after the deadline,
    ///      owner rotation resumes writes in the next epoch.
    function test_expiryEndsAuthorityAndRotationResumesWrites() public {
        TestAgent memory temporary = _register(registry, "agent-temp");
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes32 tempCap = _grantExact(alice, temporary, _one(_scope("goals.career", PERM_READ, 0)), deadline)[0];

        vm.warp(deadline - 1);
        assertTrue(registry.isAuthorized(alice.owner, temporary.agentId, career, PERM_READ));
        vm.prank(alice.owner);
        vm.expectRevert(abi.encodeWithSelector(Revocations.EpochNotExpired.selector, career));
        registry.rotateExpiredEpoch(career, _epochKey(alice.owner, "goals.career", 2));

        vm.warp(deadline);
        assertFalse(registry.isAuthorized(alice.owner, temporary.agentId, career, PERM_READ), "expired at expiresAt");
        assertFalse(registry.isCapabilityValid(tempCap));
        assertFalse(registry.isWriteEpochValid(alice.owner, career, 1), "write at exactly deadline");
        vm.warp(deadline + 1);
        assertFalse(registry.isWriteEpochValid(alice.owner, career, 1), "write after deadline");
        vm.prank(alice.owner);
        vm.expectRevert(abi.encodeWithSelector(Revocations.RotationNotApplicable.selector, tempCap));
        registry.revokeAndRotate(tempCap, _epochKey(alice.owner, "goals.career", 2));

        vm.prank(alice.owner);
        registry.rotateExpiredEpoch(career, _epochKey(alice.owner, "goals.career", 2));
        assertEq(registry.requiredReadEpoch(alice.owner, career), 2);
        assertEq(registry.writeDeadline(alice.owner, career), 0, "remaining readers are unbounded");
        assertTrue(registry.isWriteEpochValid(alice.owner, career, 2));
        assertTrue(registry.isAuthorized(alice.owner, readerD.agentId, career, PERM_READ));
    }

    function test_rotateExpiredEpochRequiresADeadline() public {
        vm.prank(alice.owner);
        vm.expectRevert(abi.encodeWithSelector(Revocations.EpochNotExpired.selector, career));
        registry.rotateExpiredEpoch(career, _epochKey(alice.owner, "goals.career", 2));
    }

    function test_expiredReadCapabilityCanBeRevokedWithoutRotation() public {
        TestAgent memory temporary = _register(registry, "agent-temp");
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes32 tempCap = _grantExact(alice, temporary, _one(_scope("goals.career", PERM_READ, 0)), deadline)[0];
        vm.warp(deadline);
        vm.prank(alice.owner);
        registry.revoke(tempCap);
        assertTrue(registry.getCapability(tempCap).revoked);
    }

    function test_policyHashConstantMatchesExport() public view {
        string memory policy = vm.readFile("test/vectors/policy-v1.json");
        assertEq(registry.POLICY_HASH_V1(), vm.parseJsonBytes32(policy, ".policyHash"));
    }
}
