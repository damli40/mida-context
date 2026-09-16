// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {WebAuthn} from "webauthn-sol/WebAuthn.sol";
import {
    AccessRequestInput,
    EpochRotationRequired,
    GrantScope,
    InvalidNamespace,
    NAMESPACE_TREE_VERSION_HASH,
    PERM_CREATE,
    PERM_READ,
    PERM_SUPERSEDE_ANY,
    PERM_SUPERSEDE_OWN,
    POLICY_VERSION_HASH,
    PROV_ALLOW_INFERENCE
} from "../src/MidaTypes.sol";
import {MidaHashing} from "../src/MidaHashing.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";
import {CapabilityStore} from "../src/CapabilityStore.sol";
import {Grants} from "../src/Grants.sol";
import {OwnerKeys} from "../src/OwnerKeys.sol";
import {ReadEpochs} from "../src/ReadEpochs.sol";
import {GrantFixtures} from "./utils/GrantFixtures.sol";
import {WebAuthnSigner} from "./utils/WebAuthnSigner.sol";

/// @notice §10.1 owner keys, §10.4 grant rules 1–13, and §15 Capability rows.
contract GrantsTest is GrantFixtures {
    TestOwner internal alice;
    TestAgent internal careerAgent;

    function setUp() public {
        _deployRegistry();
        alice = _ownerWithKey("alice");
        careerAgent = _register(registry, "career");
        _initEpoch(alice, "goals.career");
    }

    // ---------------------------------------------------------------- owner P256 keys (§10.1)

    /// @dev §15 "live session tries to overwrite registered P256 key".
    function test_registerP256KeyNeverOverwrites() public {
        (uint256 qx, uint256 qy) = WebAuthnSigner.publicKey(0xbeef);
        vm.prank(alice.owner);
        vm.expectRevert(abi.encodeWithSelector(OwnerKeys.P256KeyExists.selector, alice.owner));
        registry.registerP256Key(qx, qy);
    }

    function test_rotateP256KeyWithOldKeyAssertion() public {
        (uint256 qx, uint256 qy) = WebAuthnSigner.publicKey(0xbeef);
        bytes32 digest = MidaHashing.p256RotationDigest(block.chainid, address(registry), alice.owner, qx, qy, 0);
        // Build the assertion before vm.prank: its sha256 precompile calls would consume the prank.
        WebAuthn.WebAuthnAuth memory auth = WebAuthnSigner.sign(alice.p256Key, digest);
        vm.expectEmit(address(registry));
        emit OwnerKeys.P256KeyRegistered(alice.owner, qx, qy, 1);
        vm.prank(alice.owner);
        registry.rotateP256Key(qx, qy, auth);
        (uint256 storedX, uint256 storedY) = registry.ownerP256Key(alice.owner);
        assertEq(storedX, qx);
        assertEq(storedY, qy);
        assertEq(registry.p256RotationNonce(alice.owner), 1);
    }

    /// @dev §15 "P256 rotation lacks old-key assertion".
    function test_rotateP256KeyRequiresOldKey() public {
        (uint256 qx, uint256 qy) = WebAuthnSigner.publicKey(0xbeef);
        bytes32 digest = MidaHashing.p256RotationDigest(block.chainid, address(registry), alice.owner, qx, qy, 0);
        WebAuthn.WebAuthnAuth memory signedByNewKey = WebAuthnSigner.sign(0xbeef, digest);
        vm.prank(alice.owner);
        vm.expectRevert(OwnerKeys.WebAuthnInvalid.selector);
        registry.rotateP256Key(qx, qy, signedByNewKey);
    }

    function test_rotateP256KeyAssertionCannotBeReplayed() public {
        (uint256 qx, uint256 qy) = WebAuthnSigner.publicKey(0xbeef);
        WebAuthn.WebAuthnAuth memory auth = WebAuthnSigner.sign(
            alice.p256Key, MidaHashing.p256RotationDigest(block.chainid, address(registry), alice.owner, qx, qy, 0)
        );
        vm.startPrank(alice.owner);
        registry.rotateP256Key(qx, qy, auth);
        vm.expectRevert(OwnerKeys.WebAuthnInvalid.selector);
        registry.rotateP256Key(qx, qy, auth);
        vm.stopPrank();
    }

    function test_ownerWithoutKeyCannotGrant() public {
        address bob = makeAddr("bob");
        GrantScope[] memory scopes = _one(_scope("goals.career", PERM_READ, 0));
        AccessRequestInput memory request = _request(careerAgent, scopes, 0);
        WebAuthn.WebAuthnAuth memory auth;
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(OwnerKeys.P256KeyMissing.selector, bob));
        registry.grantBatch(request, scopes, 0, auth);
    }

    // ---------------------------------------------------------------- read epoch 1 (§10.6)

    function test_initializeReadEpochOnce() public {
        bytes32 career = _ns("goals.career");
        assertEq(registry.requiredReadEpoch(alice.owner, career), 1);
        assertEq(registry.epochPublicKey(alice.owner, career, 1), _epochKey(alice.owner, "goals.career", 1));
        assertTrue(registry.isWriteEpochValid(alice.owner, career, 1));
        assertFalse(registry.isWriteEpochValid(alice.owner, career, 2));

        vm.startPrank(alice.owner);
        vm.expectRevert(abi.encodeWithSelector(ReadEpochs.EpochAlreadyInitialized.selector, career));
        registry.initializeReadEpoch(career, keccak256("replacement key"));
        vm.expectRevert(ReadEpochs.ZeroEpochKey.selector);
        registry.initializeReadEpoch(_ns("projects.current"), bytes32(0));
        vm.expectRevert(abi.encodeWithSelector(InvalidNamespace.selector, _ns("goals.side")));
        registry.initializeReadEpoch(_ns("goals.side"), keccak256("key"));
        vm.stopPrank();

        assertFalse(registry.isWriteEpochValid(alice.owner, _ns("projects.current"), 1), "uninitialized epoch");
    }

    // ---------------------------------------------------------------- successful grants

    function test_grantStoresExactCapabilitiesAndEmits() public {
        _initEpoch(alice, "profile.skills");
        GrantScope[] memory scopes = _two(_scope("goals.career", PERM_READ, 0), _scope("profile.skills", PERM_READ, 0));
        uint64 expiresAt = uint64(block.timestamp + 7 days);
        AccessRequestInput memory request = _request(careerAgent, scopes, expiresAt);
        bytes32 requestHash = MidaHashing.accessRequestDigest(request, block.chainid, address(registry));
        bytes32 firstId = MidaHashing.capabilityId(alice.owner, careerAgent.agentId, 0, 0, scopes[0], expiresAt);

        vm.expectEmit(address(registry));
        emit Grants.CapabilityGranted(
            alice.owner,
            careerAgent.agentId,
            scopes[0].namespaceId,
            firstId,
            PERM_READ,
            0,
            expiresAt,
            Grants.GrantContext(requestHash, careerAgent.manifestHash, 1, POLICY_VERSION_HASH, NAMESPACE_TREE_VERSION_HASH, 0)
        );
        bytes32[] memory ids = _grant(alice, request, scopes, expiresAt);

        assertEq(ids.length, 2);
        assertEq(ids[0], firstId);
        assertEq(ids[1], MidaHashing.capabilityId(alice.owner, careerAgent.agentId, 0, 1, scopes[1], expiresAt));
        CapabilityStore.Capability memory capability = registry.getCapability(ids[1]);
        assertEq(capability.owner, alice.owner);
        assertEq(capability.agentId, careerAgent.agentId);
        assertEq(capability.namespaceId, scopes[1].namespaceId);
        assertEq(capability.permissions, PERM_READ);
        assertEq(capability.issuedAt, block.timestamp);
        assertEq(capability.expiresAt, expiresAt);
        assertEq(capability.agentEpoch, 0);
        assertEq(capability.grantedAtReadEpoch, 1);
        assertFalse(capability.revoked);
        assertTrue(registry.isCapabilityValid(ids[0]));
        assertEq(registry.grantNonce(alice.owner), 1);
    }

    /// @dev §15 "user narrows requested permissions".
    function test_userNarrowingAccepted() public {
        uint64 requestedExpiry = uint64(block.timestamp + 7 days);
        AccessRequestInput memory request = _request(
            careerAgent,
            _one(_scope("goals.career", PERM_READ | PERM_CREATE | PERM_SUPERSEDE_OWN, PROV_ALLOW_INFERENCE)),
            requestedExpiry
        );
        uint64 narrowerExpiry = uint64(block.timestamp + 1 days);
        bytes32[] memory ids = _grant(alice, request, _one(_scope("goals.career", PERM_READ, 0)), narrowerExpiry);
        CapabilityStore.Capability memory capability = registry.getCapability(ids[0]);
        assertEq(capability.permissions, PERM_READ);
        assertEq(capability.provenancePolicy, 0);
        assertEq(capability.expiresAt, narrowerExpiry);
    }

    function test_createOnlyGrantNeedsNoEpoch() public {
        uint64 expiresAt = uint64(block.timestamp + 1 days);
        bytes32[] memory ids = _grantExact(alice, careerAgent, _one(_scope("projects.current", PERM_CREATE, 0)), expiresAt);
        assertEq(registry.getCapability(ids[0]).grantedAtReadEpoch, 0);
    }

    // ---------------------------------------------------------------- replay and binding

    /// @dev §15 "replay grant assertion".
    function test_replayedGrantAssertionRejected() public {
        GrantScope[] memory scopes = _one(_scope("goals.career", PERM_READ, 0));
        uint64 expiresAt = uint64(block.timestamp + 1 days);
        AccessRequestInput memory request = _request(careerAgent, scopes, expiresAt);
        WebAuthn.WebAuthnAuth memory auth = _assertion(alice, request, scopes, expiresAt);
        vm.startPrank(alice.owner);
        registry.grantBatch(request, scopes, expiresAt, auth);
        vm.expectRevert(OwnerKeys.WebAuthnInvalid.selector);
        registry.grantBatch(request, scopes, expiresAt, auth);
        vm.stopPrank();
    }

    /// @dev §15 "wrong request/manifest/policy/tree hash in P256 challenge".
    function test_challengeBindsRequestScopesAndExpiry() public {
        GrantScope[] memory scopes = _one(_scope("goals.career", PERM_READ, 0));
        uint64 expiresAt = uint64(block.timestamp + 1 days);
        AccessRequestInput memory request = _request(careerAgent, _one(_scope("goals.career", PERM_READ | PERM_CREATE, 0)), expiresAt);

        WebAuthn.WebAuthnAuth memory wrongExpiry = WebAuthnSigner.sign(
            alice.p256Key, _grantDigestFor(alice.owner, request, scopes, expiresAt - 1, 0, block.chainid, address(registry))
        );
        WebAuthn.WebAuthnAuth memory wrongScopes = WebAuthnSigner.sign(
            alice.p256Key,
            _grantDigestFor(
                alice.owner, request, _one(_scope("goals.career", PERM_READ | PERM_CREATE, 0)), expiresAt, 0, block.chainid, address(registry)
            )
        );
        AccessRequestInput memory otherRequest = _unsignedRequest(careerAgent, scopes, expiresAt);
        otherRequest.requestId = keccak256("a different request");
        WebAuthn.WebAuthnAuth memory wrongRequest = WebAuthnSigner.sign(
            alice.p256Key, _grantDigestFor(alice.owner, otherRequest, scopes, expiresAt, 0, block.chainid, address(registry))
        );

        vm.startPrank(alice.owner);
        vm.expectRevert(OwnerKeys.WebAuthnInvalid.selector);
        registry.grantBatch(request, scopes, expiresAt, wrongExpiry);
        vm.expectRevert(OwnerKeys.WebAuthnInvalid.selector);
        registry.grantBatch(request, scopes, expiresAt, wrongScopes);
        vm.expectRevert(OwnerKeys.WebAuthnInvalid.selector);
        registry.grantBatch(request, scopes, expiresAt, wrongRequest);
        vm.stopPrank();
    }

    function test_unsupportedPolicyOrTreeVersionRejected() public {
        GrantScope[] memory scopes = _one(_scope("goals.career", PERM_READ, 0));
        AccessRequestInput memory request = _unsignedRequest(careerAgent, scopes, 0);
        request.policyVersionHash = keccak256("mida-grant-policy-v2");
        _signRequest(careerAgent, request);
        _expectGrantRevert(alice, request, scopes, 0, abi.encodeWithSelector(Grants.VersionUnsupported.selector));

        request = _unsignedRequest(careerAgent, scopes, 0);
        request.namespaceTreeVersionHash = keccak256("mida-namespace-tree-v2");
        _signRequest(careerAgent, request);
        _expectGrantRevert(alice, request, scopes, 0, abi.encodeWithSelector(Grants.VersionUnsupported.selector));
    }

    /// @dev §15 "manifest updates between request and grant".
    function test_manifestUpdatedAfterRequestRejected() public {
        GrantScope[] memory scopes = _one(_scope("goals.career", PERM_READ, 0));
        AccessRequestInput memory request = _request(careerAgent, scopes, 0);
        bytes32 body = keccak256("manifest v2");
        bytes memory binding = _sign(
            careerAgent.operatorKey,
            MidaHashing.manifestBindingDigest(body, careerAgent.agentId, 2, block.chainid, address(registry))
        );
        vm.prank(careerAgent.operator);
        registry.updateAgentCapabilityManifest(careerAgent.agentId, body, 2, binding);
        _expectGrantRevert(alice, request, scopes, 0, abi.encodeWithSelector(Grants.ManifestStale.selector));
    }

    /// @dev §15 "grant signed for wrong chain or registry".
    function test_grantBoundToChainAndRegistry() public {
        GrantScope[] memory scopes = _one(_scope("goals.career", PERM_READ, 0));
        AccessRequestInput memory request = _request(careerAgent, scopes, 0);
        WebAuthn.WebAuthnAuth memory otherChain =
            WebAuthnSigner.sign(alice.p256Key, _grantDigestFor(alice.owner, request, scopes, 0, 0, 10143, address(registry)));
        WebAuthn.WebAuthnAuth memory otherRegistry =
            WebAuthnSigner.sign(alice.p256Key, _grantDigestFor(alice.owner, request, scopes, 0, 0, block.chainid, address(0xBEEF)));
        vm.startPrank(alice.owner);
        vm.expectRevert(OwnerKeys.WebAuthnInvalid.selector);
        registry.grantBatch(request, scopes, 0, otherChain);
        vm.expectRevert(OwnerKeys.WebAuthnInvalid.selector);
        registry.grantBatch(request, scopes, 0, otherRegistry);
        vm.stopPrank();

        AccessRequestInput memory signedForOtherRegistry = _unsignedRequest(careerAgent, scopes, 0);
        signedForOtherRegistry.agentSignature = _sign(
            careerAgent.signerKey, MidaHashing.accessRequestDigest(signedForOtherRegistry, block.chainid, address(0xBEEF))
        );
        _expectGrantRevert(alice, signedForOtherRegistry, scopes, 0, abi.encodeWithSelector(AgentRegistry.InvalidSignature.selector));
    }

    /// @dev §15 "grant signed without user-verification flag".
    function test_grantWithoutUserVerificationRejected() public {
        GrantScope[] memory scopes = _one(_scope("goals.career", PERM_READ, 0));
        AccessRequestInput memory request = _request(careerAgent, scopes, 0);
        WebAuthn.WebAuthnAuth memory auth = WebAuthnSigner.signWith(
            alice.p256Key,
            _grantDigestFor(alice.owner, request, scopes, 0, 0, block.chainid, address(registry)),
            WebAuthnSigner.VAULT_RP_ID,
            WebAuthnSigner.VAULT_ORIGIN,
            WebAuthnSigner.FLAGS_UP_ONLY
        );
        vm.prank(alice.owner);
        vm.expectRevert(OwnerKeys.WebAuthnInvalid.selector);
        registry.grantBatch(request, scopes, 0, auth);
    }

    /// @dev §15 "assertion whose authenticatorData[0:32] is not the configured Vault RP-ID hash".
    function test_grantWithForeignRpIdRejected() public {
        GrantScope[] memory scopes = _one(_scope("goals.career", PERM_READ, 0));
        AccessRequestInput memory request = _request(careerAgent, scopes, 0);
        WebAuthn.WebAuthnAuth memory auth = WebAuthnSigner.signWith(
            alice.p256Key,
            _grantDigestFor(alice.owner, request, scopes, 0, 0, block.chainid, address(registry)),
            "evil.example",
            WebAuthnSigner.VAULT_ORIGIN,
            WebAuthnSigner.FLAGS_UP_UV
        );
        vm.prank(alice.owner);
        vm.expectRevert(OwnerKeys.WebAuthnInvalid.selector);
        registry.grantBatch(request, scopes, 0, auth);
    }

    // ---------------------------------------------------------------- request validity

    function test_requestTimingEnforced() public {
        GrantScope[] memory scopes = _one(_scope("goals.career", PERM_READ, 0));
        bytes memory expired = abi.encodeWithSelector(Grants.RequestExpired.selector);

        AccessRequestInput memory future = _unsignedRequest(careerAgent, scopes, 0);
        future.issuedAt = uint64(block.timestamp + 1);
        _signRequest(careerAgent, future);
        _expectGrantRevert(alice, future, scopes, 0, expired);

        AccessRequestInput memory tooLong = _unsignedRequest(careerAgent, scopes, 0);
        tooLong.requestExpiresAt = tooLong.issuedAt + 601;
        _signRequest(careerAgent, tooLong);
        _expectGrantRevert(alice, tooLong, scopes, 0, expired);

        AccessRequestInput memory stale = _request(careerAgent, scopes, 0);
        vm.warp(stale.requestExpiresAt);
        _expectGrantRevert(alice, stale, scopes, 0, expired);
    }

    function test_requestMustBeSignedByCurrentAgentSigner() public {
        GrantScope[] memory scopes = _one(_scope("goals.career", PERM_READ, 0));
        AccessRequestInput memory request = _unsignedRequest(careerAgent, scopes, 0);
        request.agentSignature =
            _sign(careerAgent.operatorKey, MidaHashing.accessRequestDigest(request, block.chainid, address(registry)));
        _expectGrantRevert(alice, request, scopes, 0, abi.encodeWithSelector(AgentRegistry.InvalidSignature.selector));
    }

    function test_callbackOriginMustMatchRegisteredAgent() public {
        GrantScope[] memory scopes = _one(_scope("goals.career", PERM_READ, 0));
        AccessRequestInput memory request = _unsignedRequest(careerAgent, scopes, 0);
        request.callbackOriginHash = keccak256("https://evil.example");
        _signRequest(careerAgent, request);
        _expectGrantRevert(alice, request, scopes, 0, abi.encodeWithSelector(Grants.CallbackOriginMismatch.selector));
    }

    function test_unknownAgentRejected() public {
        GrantScope[] memory scopes = _one(_scope("goals.career", PERM_READ, 0));
        AccessRequestInput memory request = _request(careerAgent, scopes, 0);
        request.agentId = keccak256("nobody");
        WebAuthn.WebAuthnAuth memory auth;
        vm.prank(alice.owner);
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.AgentNotFound.selector, request.agentId));
        registry.grantBatch(request, scopes, 0, auth);
    }

    // ---------------------------------------------------------------- exact scopes and subset (rules 5, 6)

    function test_scopesMustBeCanonical() public {
        _initEpoch(alice, "profile.skills");
        GrantScope[] memory requested = _two(_scope("goals.career", PERM_READ, 1), _scope("profile.skills", PERM_READ, 1));
        AccessRequestInput memory request = _request(careerAgent, requested, 0);
        bytes memory notCanonical = abi.encodeWithSelector(Grants.ScopesNotCanonical.selector);

        GrantScope[] memory reversed = new GrantScope[](2);
        reversed[0] = requested[1];
        reversed[1] = requested[0];
        _expectGrantRevert(alice, request, reversed, 0, notCanonical);

        GrantScope[] memory duplicated = new GrantScope[](2);
        duplicated[0] = requested[0];
        duplicated[1] = requested[0];
        _expectGrantRevert(alice, request, duplicated, 0, notCanonical);

        _expectGrantRevert(alice, request, new GrantScope[](0), 0, notCanonical);
        _expectGrantRevert(alice, request, _one(_scope("goals.career", 0, 0)), 0, notCanonical);
        _expectGrantRevert(alice, request, _one(_scope("goals.career", 16, 0)), 0, notCanonical);
        _expectGrantRevert(alice, request, _one(_scope("goals.career", PERM_READ, 8)), 0, notCanonical);

        AccessRequestInput memory unknown = _request(careerAgent, _one(_scope("goals.side", PERM_READ, 0)), 0);
        _expectGrantRevert(
            alice, unknown, _one(_scope("goals.side", PERM_READ, 0)), 0, abi.encodeWithSelector(InvalidNamespace.selector, _ns("goals.side"))
        );
    }

    /// @dev §15 "final exact authority exceeds signed request".
    function test_finalAuthorityBeyondRequestRejected() public {
        uint64 expiresAt = uint64(block.timestamp + 1 days);
        AccessRequestInput memory request =
            _request(careerAgent, _one(_scope("goals.career", PERM_READ | PERM_CREATE, PROV_ALLOW_INFERENCE)), expiresAt);
        bytes memory exceeds = abi.encodeWithSelector(Grants.AuthorityExceedsRequest.selector, _ns("goals.career"));

        _expectGrantRevert(alice, request, _one(_scope("goals.career", PERM_READ | PERM_SUPERSEDE_ANY, 0)), expiresAt, exceeds);
        _expectGrantRevert(alice, request, _one(_scope("goals.career", PERM_READ, 3)), expiresAt, exceeds);
        _expectGrantRevert(
            alice,
            request,
            _two(_scope("goals.career", PERM_READ, 0), _scope("projects.current", PERM_CREATE, 0)),
            expiresAt,
            abi.encodeWithSelector(Grants.AuthorityExceedsRequest.selector, _ns("projects.current"))
        );
    }

    function testFuzz_finalAuthorityMustBeSubsetOfRequest(
        uint8 requestedPermissions,
        uint8 finalPermissions,
        uint8 requestedProvenance,
        uint8 finalProvenance
    ) public {
        requestedPermissions = uint8(bound(requestedPermissions, 1, 15));
        finalPermissions = uint8(bound(finalPermissions, 1, 15));
        requestedProvenance = uint8(bound(requestedProvenance, 0, 7));
        finalProvenance = uint8(bound(finalProvenance, 0, 7));
        uint64 expiresAt = uint64(block.timestamp + 1 days);

        AccessRequestInput memory request =
            _request(careerAgent, _one(_scope("goals.career", requestedPermissions, requestedProvenance)), expiresAt);
        GrantScope[] memory finalScopes = _one(_scope("goals.career", finalPermissions, finalProvenance));
        WebAuthn.WebAuthnAuth memory auth = _assertion(alice, request, finalScopes, expiresAt);
        bool subset = finalPermissions & ~requestedPermissions == 0 && finalProvenance & ~requestedProvenance == 0;

        vm.prank(alice.owner);
        if (!subset) {
            vm.expectRevert(abi.encodeWithSelector(Grants.AuthorityExceedsRequest.selector, _ns("goals.career")));
        }
        registry.grantBatch(request, finalScopes, expiresAt, auth);
        if (subset) assertEq(registry.grantNonce(alice.owner), 1);
    }

    // ---------------------------------------------------------------- expiry (rule 7)

    function test_expiryCanOnlyNarrow() public {
        GrantScope[] memory scopes = _one(_scope("goals.career", PERM_READ, 0));
        bytes memory invalid = abi.encodeWithSelector(Grants.ExpiryInvalid.selector);

        AccessRequestInput memory finite = _request(careerAgent, scopes, uint64(block.timestamp + 1 days));
        _expectGrantRevert(alice, finite, scopes, uint64(block.timestamp + 2 days), invalid);
        _expectGrantRevert(alice, finite, scopes, 0, invalid);

        AccessRequestInput memory unbounded = _request(careerAgent, scopes, 0);
        _expectGrantRevert(alice, unbounded, scopes, uint64(block.timestamp), invalid);
        _grant(alice, unbounded, scopes, uint64(block.timestamp + 1 hours));
        _grant(alice, _request(careerAgent, scopes, 0), scopes, 0);
    }

    /// @dev §15 "HIGH final grant exceeds 24 hours or is unbounded".
    function test_highSensitivityRequiresFiniteExpiryWithin24Hours() public {
        _initEpoch(alice, "financial");
        GrantScope[] memory scopes = _one(_scope("financial", PERM_READ, 0));
        AccessRequestInput memory request = _request(careerAgent, scopes, 0);
        bytes memory high = abi.encodeWithSelector(Grants.HighSensitivityExpiry.selector, _ns("financial"));
        _expectGrantRevert(alice, request, scopes, 0, high);
        _expectGrantRevert(alice, request, scopes, uint64(block.timestamp + 24 hours + 1), high);
        _grant(alice, request, scopes, uint64(block.timestamp + 24 hours));
    }

    // ---------------------------------------------------------------- epochs at grant time (rules 9, 13)

    function test_readGrantRequiresInitializedWritableEpoch() public {
        GrantScope[] memory uninitialized = _one(_scope("projects.current", PERM_READ, 0));
        _expectGrantRevert(
            alice,
            _request(careerAgent, uninitialized, 0),
            uninitialized,
            0,
            abi.encodeWithSelector(EpochRotationRequired.selector, _ns("projects.current"), uint64(1))
        );

        GrantScope[] memory career = _one(_scope("goals.career", PERM_READ, 0));
        _grantExact(alice, careerAgent, career, uint64(block.timestamp + 1 hours));
        vm.warp(block.timestamp + 1 hours);
        _expectGrantRevert(
            alice,
            _request(careerAgent, career, 0),
            career,
            0,
            abi.encodeWithSelector(EpochRotationRequired.selector, _ns("goals.career"), uint64(1))
        );
    }

    /// @dev §15 "new short-lived reader lowers deadline" and "write at exactly deadline".
    function test_shortLivedReaderLowersWriteDeadline() public {
        bytes32 career = _ns("goals.career");
        GrantScope[] memory read = _one(_scope("goals.career", PERM_READ, 0));
        uint64 inOneDay = uint64(block.timestamp + 1 days);

        _grantExact(alice, careerAgent, read, uint64(block.timestamp + 7 days));
        assertEq(registry.writeDeadline(alice.owner, career), block.timestamp + 7 days);
        _grantExact(alice, careerAgent, read, inOneDay);
        assertEq(registry.writeDeadline(alice.owner, career), inOneDay);
        _grantExact(alice, careerAgent, read, uint64(block.timestamp + 3 days));
        _grantExact(alice, careerAgent, read, 0);
        _grantExact(alice, careerAgent, _one(_scope("goals.career", PERM_CREATE, 0)), uint64(block.timestamp + 1 hours));
        assertEq(registry.writeDeadline(alice.owner, career), inOneDay);

        assertTrue(registry.isWriteEpochValid(alice.owner, career, 1));
        vm.warp(inOneDay - 1);
        assertTrue(registry.isWriteEpochValid(alice.owner, career, 1));
        vm.warp(inOneDay);
        assertFalse(registry.isWriteEpochValid(alice.owner, career, 1));
    }

    // ---------------------------------------------------------------- bounded active capabilities (rule 8)

    function test_activeCapabilityLimitPerNamespace() public {
        GrantScope[] memory create = _one(_scope("goals.career", PERM_CREATE, 0));
        uint64 expiresAt = uint64(block.timestamp + 1 days);
        for (uint256 i = 0; i < 32; i++) {
            _grantExact(alice, _register(registry, string.concat("agent-", vm.toString(i))), create, expiresAt);
        }
        TestAgent memory extra = _register(registry, "agent-32");
        _expectGrantRevert(
            alice,
            _request(extra, create, expiresAt),
            create,
            expiresAt,
            abi.encodeWithSelector(CapabilityStore.CapabilityLimit.selector, _ns("goals.career"))
        );

        // Under via-IR a test must not re-read block.timestamp after vm.warp; use absolute values.
        vm.warp(expiresAt);
        _grantExact(alice, extra, create, expiresAt + 1 days);
        assertEq(registry.activeCapabilityIds(alice.owner, extra.agentId).length, 1);
    }

    function test_activeCapabilityLimitPerAgent() public {
        string[22] memory names = [
            "profile", "profile.identity", "profile.skills", "goals", "goals.career", "goals.learning",
            "goals.personal", "preferences", "preferences.communication", "preferences.tools", "preferences.work",
            "projects", "projects.current", "projects.past", "decisions", "decisions.career", "decisions.projects",
            "credentials", "financial", "financial.preferences", "relationships", "private"
        ];
        GrantScope[] memory all = new GrantScope[](22);
        for (uint256 i = 0; i < 22; i++) {
            all[i] = _scope(names[i], PERM_CREATE, 0);
        }
        _sortScopes(all);
        uint64 expiresAt = uint64(block.timestamp + 1 hours);

        _grantExact(alice, careerAgent, all, expiresAt);
        _grantExact(alice, careerAgent, all, expiresAt);
        AccessRequestInput memory third = _request(careerAgent, all, expiresAt);
        WebAuthn.WebAuthnAuth memory auth = _assertion(alice, third, all, expiresAt);
        vm.prank(alice.owner);
        // 44 live entries plus the first 20 scopes of this batch reach 64; the 21st reverts.
        vm.expectRevert(abi.encodeWithSelector(CapabilityStore.CapabilityLimit.selector, all[20].namespaceId));
        registry.grantBatch(third, all, expiresAt, auth);
        assertEq(registry.activeCapabilityIds(alice.owner, careerAgent.agentId).length, 44);
    }
}
