// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {WebAuthn} from "webauthn-sol/WebAuthn.sol";
import {
    AccessRequestInput,
    GrantDigestInput,
    GrantScope,
    NAMESPACE_TREE_VERSION_HASH,
    POLICY_VERSION_HASH
} from "../../src/MidaTypes.sol";
import {MidaHashing} from "../../src/MidaHashing.sol";
import {CapabilityRegistry} from "../../src/CapabilityRegistry.sol";
import {AgentFixtures} from "./AgentFixtures.sol";
import {WebAuthnSigner} from "./WebAuthnSigner.sol";

/// @notice Owner, request and grant helpers. Requests are signed exactly as the SDK signs them;
///         grant assertions are WebAuthn assertions over grantDigest with the owner's P256 key.
abstract contract GrantFixtures is AgentFixtures {
    struct TestOwner {
        address owner;
        uint256 p256Key;
    }

    uint256 internal constant START_TIME = 1_750_000_000;

    CapabilityRegistry internal registry;

    function _deployRegistry() internal {
        vm.warp(START_TIME);
        registry = new CapabilityRegistry(WebAuthnSigner.VAULT_RP_ID);
    }

    function _ownerWithKey(string memory label) internal returns (TestOwner memory testOwner) {
        testOwner.owner = makeAddr(label);
        testOwner.p256Key = uint256(keccak256(abi.encode(label, "p256"))) % (WebAuthnSigner.P256_N - 1) + 1;
        (uint256 qx, uint256 qy) = WebAuthnSigner.publicKey(testOwner.p256Key);
        vm.prank(testOwner.owner);
        registry.registerP256Key(qx, qy);
    }

    function _ns(string memory name) internal pure returns (bytes32) {
        return MidaHashing.namespaceId(name);
    }

    function _scope(string memory name, uint8 permissions, uint8 provenancePolicy)
        internal
        pure
        returns (GrantScope memory)
    {
        return GrantScope(_ns(name), permissions, provenancePolicy);
    }

    function _one(GrantScope memory a) internal pure returns (GrantScope[] memory scopes) {
        scopes = new GrantScope[](1);
        scopes[0] = a;
    }

    function _two(GrantScope memory a, GrantScope memory b) internal pure returns (GrantScope[] memory scopes) {
        scopes = new GrantScope[](2);
        scopes[0] = a;
        scopes[1] = b;
        _sortScopes(scopes);
    }

    function _sortScopes(GrantScope[] memory scopes) internal pure {
        for (uint256 i = 1; i < scopes.length; i++) {
            GrantScope memory key = scopes[i];
            uint256 j = i;
            while (j > 0 && uint256(scopes[j - 1].namespaceId) > uint256(key.namespaceId)) {
                scopes[j] = scopes[j - 1];
                j--;
            }
            scopes[j] = key;
        }
    }

    function _epochKey(address owner, string memory name, uint64 epoch) internal pure returns (bytes32) {
        return keccak256(abi.encode(owner, name, epoch));
    }

    function _initEpoch(TestOwner memory testOwner, string memory name) internal {
        vm.prank(testOwner.owner);
        registry.initializeReadEpoch(_ns(name), _epochKey(testOwner.owner, name, 1));
    }

    function _unsignedRequest(TestAgent memory agent, GrantScope[] memory scopes, uint64 capabilityExpiresAt)
        internal
        view
        returns (AccessRequestInput memory request)
    {
        request.requestId = keccak256(abi.encode(agent.agentId, "request", block.timestamp, scopes));
        request.nonce = keccak256(abi.encode(request.requestId, "nonce"));
        request.agentId = agent.agentId;
        request.purposeIdHash = keccak256("career_coaching");
        request.callbackOriginHash = agent.callbackOriginHash;
        request.manifestHash = agent.manifestHash;
        request.manifestVersion = 1;
        request.policyVersionHash = POLICY_VERSION_HASH;
        request.namespaceTreeVersionHash = NAMESPACE_TREE_VERSION_HASH;
        request.issuedAt = uint64(block.timestamp);
        request.requestExpiresAt = uint64(block.timestamp + 300);
        request.capabilityExpiresAt = capabilityExpiresAt;
        request.scopes = scopes;
    }

    function _signRequest(TestAgent memory agent, AccessRequestInput memory request) internal view {
        request.agentSignature =
            _sign(agent.signerKey, MidaHashing.accessRequestDigest(request, block.chainid, address(registry)));
    }

    function _request(TestAgent memory agent, GrantScope[] memory scopes, uint64 capabilityExpiresAt)
        internal
        view
        returns (AccessRequestInput memory request)
    {
        request = _unsignedRequest(agent, scopes, capabilityExpiresAt);
        _signRequest(agent, request);
    }

    /// @dev requestHash is always computed for the real chain and registry; chainId and verifyingRegistry
    ///      only change the outer grant digest, which models an assertion signed for the wrong deployment.
    function _grantDigestFor(
        address owner,
        AccessRequestInput memory request,
        GrantScope[] memory finalScopes,
        uint64 expiresAt,
        uint256 nonce,
        uint256 chainId,
        address verifyingRegistry
    ) internal view returns (bytes32) {
        return MidaHashing.grantDigest(
            GrantDigestInput({
                chainId: chainId,
                capabilityRegistry: verifyingRegistry,
                owner: owner,
                agentId: request.agentId,
                requestHash: MidaHashing.accessRequestDigest(request, block.chainid, address(registry)),
                manifestHash: request.manifestHash,
                manifestVersion: request.manifestVersion,
                scopesHash: MidaHashing.scopesHash(finalScopes),
                expiresAt: expiresAt,
                grantNonce: nonce
            })
        );
    }

    function _assertion(
        TestOwner memory testOwner,
        AccessRequestInput memory request,
        GrantScope[] memory finalScopes,
        uint64 expiresAt
    ) internal view returns (WebAuthn.WebAuthnAuth memory) {
        bytes32 digest = _grantDigestFor(
            testOwner.owner,
            request,
            finalScopes,
            expiresAt,
            registry.grantNonce(testOwner.owner),
            block.chainid,
            address(registry)
        );
        return WebAuthnSigner.sign(testOwner.p256Key, digest);
    }

    function _grant(
        TestOwner memory testOwner,
        AccessRequestInput memory request,
        GrantScope[] memory finalScopes,
        uint64 expiresAt
    ) internal returns (bytes32[] memory capabilityIds) {
        WebAuthn.WebAuthnAuth memory auth = _assertion(testOwner, request, finalScopes, expiresAt);
        vm.prank(testOwner.owner);
        capabilityIds = registry.grantBatch(request, finalScopes, expiresAt, auth);
    }

    function _grantExact(TestOwner memory testOwner, TestAgent memory agent, GrantScope[] memory scopes, uint64 expiresAt)
        internal
        returns (bytes32[] memory)
    {
        return _grant(testOwner, _request(agent, scopes, expiresAt), scopes, expiresAt);
    }

    function _expectGrantRevert(
        TestOwner memory testOwner,
        AccessRequestInput memory request,
        GrantScope[] memory finalScopes,
        uint64 expiresAt,
        bytes memory revertData
    ) internal {
        WebAuthn.WebAuthnAuth memory auth = _assertion(testOwner, request, finalScopes, expiresAt);
        vm.prank(testOwner.owner);
        vm.expectRevert(revertData);
        registry.grantBatch(request, finalScopes, expiresAt, auth);
    }
}
