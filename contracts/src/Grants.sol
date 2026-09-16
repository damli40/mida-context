// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {WebAuthn} from "webauthn-sol/WebAuthn.sol";
import {
    AccessRequestInput,
    EpochRotationRequired,
    GrantDigestInput,
    GrantScope,
    HIGH_MAX_DURATION,
    InvalidNamespace,
    KNOWN_PERMISSION_BITS,
    KNOWN_PROVENANCE_BITS,
    MAX_REQUEST_WINDOW,
    NAMESPACE_TREE_VERSION_HASH,
    PERM_READ,
    POLICY_VERSION_HASH
} from "./MidaTypes.sol";
import {AgentRegistry} from "./AgentRegistry.sol";
import {CapabilityStore} from "./CapabilityStore.sol";
import {MidaHashing} from "./MidaHashing.sol";
import {NamespaceTree} from "./NamespaceTree.sol";
import {OwnerKeys} from "./OwnerKeys.sol";
import {ReadEpochs} from "./ReadEpochs.sol";
import {SignatureRecovery} from "./SignatureRecovery.sol";

/// @notice grantBatch (spec §10.4): the agent-signed request bounds authority, the owner's passkey
///         assertion binds the final exact authority, and a contract nonce prevents replay.
abstract contract Grants is NamespaceTree, AgentRegistry, OwnerKeys, CapabilityStore, ReadEpochs {
    struct GrantContext {
        bytes32 requestHash;
        bytes32 manifestHash;
        uint64 manifestVersion;
        bytes32 policyVersionHash;
        bytes32 namespaceTreeVersionHash;
        uint256 grantNonce;
    }

    error VersionUnsupported();
    error RequestExpired();
    error ManifestStale();
    error CallbackOriginMismatch();
    error ScopesNotCanonical();
    error AuthorityExceedsRequest(bytes32 namespaceId);
    error ExpiryInvalid();
    error HighSensitivityExpiry(bytes32 namespaceId);

    mapping(address owner => uint256) public grantNonce;

    event CapabilityGranted(
        address indexed owner,
        bytes32 indexed agentId,
        bytes32 indexed namespaceId,
        bytes32 capabilityId,
        uint8 permissions,
        uint8 provenancePolicy,
        uint64 expiresAt,
        GrantContext context
    );

    function grantBatch(
        AccessRequestInput calldata request,
        GrantScope[] calldata finalScopes,
        uint64 expiresAt,
        WebAuthn.WebAuthnAuth calldata auth
    ) external returns (bytes32[] memory capabilityIds) {
        P256Key memory ownerKey = _requireOwnerKey(msg.sender);
        bytes32 requestHash = _verifyRequest(request);
        _requireCanonical(finalScopes);
        _requireSubset(request.scopes, finalScopes);
        _requireExpiry(request.capabilityExpiresAt, finalScopes, expiresAt);

        uint256 nonce = grantNonce[msg.sender];
        bytes32 digest = MidaHashing.grantDigest(
            GrantDigestInput({
                chainId: block.chainid,
                capabilityRegistry: address(this),
                owner: msg.sender,
                agentId: request.agentId,
                requestHash: requestHash,
                manifestHash: request.manifestHash,
                manifestVersion: request.manifestVersion,
                scopesHash: MidaHashing.scopesHash(finalScopes),
                expiresAt: expiresAt,
                grantNonce: nonce
            })
        );
        if (!_verifyVaultAssertion(digest, auth, ownerKey.qx, ownerKey.qy)) revert WebAuthnInvalid();
        grantNonce[msg.sender] = nonce + 1;

        GrantContext memory context = GrantContext({
            requestHash: requestHash,
            manifestHash: request.manifestHash,
            manifestVersion: request.manifestVersion,
            policyVersionHash: POLICY_VERSION_HASH,
            namespaceTreeVersionHash: NAMESPACE_TREE_VERSION_HASH,
            grantNonce: nonce
        });
        capabilityIds = new bytes32[](finalScopes.length);
        for (uint256 i = 0; i < finalScopes.length; i++) {
            capabilityIds[i] = _grantOne(request.agentId, finalScopes[i], i, expiresAt, context);
        }
    }

    function _verifyRequest(AccessRequestInput calldata request) private view returns (bytes32 requestHash) {
        if (
            request.policyVersionHash != POLICY_VERSION_HASH
                || request.namespaceTreeVersionHash != NAMESPACE_TREE_VERSION_HASH
        ) revert VersionUnsupported();
        if (
            request.issuedAt > block.timestamp || block.timestamp >= request.requestExpiresAt
                || request.requestExpiresAt - request.issuedAt > MAX_REQUEST_WINDOW
        ) revert RequestExpired();

        AgentRecord storage agent = _activeAgent(request.agentId);
        if (
            request.manifestHash != agent.capabilityManifestHash
                || request.manifestVersion != agent.capabilityManifestVersion
        ) revert ManifestStale();
        if (request.callbackOriginHash != agent.callbackOriginHash) revert CallbackOriginMismatch();
        _requireCanonical(request.scopes);

        requestHash = MidaHashing.accessRequestDigest(request, block.chainid, address(this));
        if (SignatureRecovery.recover(requestHash, request.agentSignature) != agent.signer) revert InvalidSignature();
    }

    /// @dev Non-empty, strictly ascending by namespaceId, registered, non-zero known permission bits,
    ///      known provenance bits. Mirrors assertCanonicalScopes() in the TypeScript protocol package.
    function _requireCanonical(GrantScope[] calldata scopes) private view {
        if (scopes.length == 0) revert ScopesNotCanonical();
        for (uint256 i = 0; i < scopes.length; i++) {
            GrantScope calldata scope = scopes[i];
            if (!isRegisteredNamespace(scope.namespaceId)) revert InvalidNamespace(scope.namespaceId);
            if (i > 0 && uint256(scope.namespaceId) <= uint256(scopes[i - 1].namespaceId)) revert ScopesNotCanonical();
            if (scope.permissions == 0 || scope.permissions & ~KNOWN_PERMISSION_BITS != 0) revert ScopesNotCanonical();
            if (scope.provenancePolicy & ~KNOWN_PROVENANCE_BITS != 0) revert ScopesNotCanonical();
        }
    }

    /// @dev Both lists are canonical, so one forward pass proves every final bit was requested.
    function _requireSubset(GrantScope[] calldata requested, GrantScope[] calldata finalScopes) private pure {
        uint256 j;
        for (uint256 i = 0; i < finalScopes.length; i++) {
            GrantScope calldata granted = finalScopes[i];
            while (j < requested.length && uint256(requested[j].namespaceId) < uint256(granted.namespaceId)) j++;
            if (j == requested.length || requested[j].namespaceId != granted.namespaceId) {
                revert AuthorityExceedsRequest(granted.namespaceId);
            }
            if (
                granted.permissions & ~requested[j].permissions != 0
                    || granted.provenancePolicy & ~requested[j].provenancePolicy != 0
            ) revert AuthorityExceedsRequest(granted.namespaceId);
        }
    }

    function _requireExpiry(uint64 requestedExpiry, GrantScope[] calldata finalScopes, uint64 expiresAt) private view {
        if (requestedExpiry != 0 && (expiresAt == 0 || expiresAt > requestedExpiry)) revert ExpiryInvalid();
        if (expiresAt != 0 && expiresAt <= block.timestamp) revert ExpiryInvalid();
        for (uint256 i = 0; i < finalScopes.length; i++) {
            if (!isHighSensitivity(finalScopes[i].namespaceId)) continue;
            if (expiresAt == 0 || expiresAt > block.timestamp + HIGH_MAX_DURATION) {
                revert HighSensitivityExpiry(finalScopes[i].namespaceId);
            }
        }
    }

    function _grantOne(bytes32 agentId, GrantScope calldata scope, uint256 index, uint64 expiresAt, GrantContext memory context)
        private
        returns (bytes32 capabilityId)
    {
        capabilityId = MidaHashing.capabilityId(msg.sender, agentId, context.grantNonce, index, scope, expiresAt);
        uint64 grantedAtReadEpoch;
        if (scope.permissions & PERM_READ != 0) {
            grantedAtReadEpoch = requiredReadEpoch(msg.sender, scope.namespaceId);
            if (!isWriteEpochValid(msg.sender, scope.namespaceId, grantedAtReadEpoch)) {
                revert EpochRotationRequired(scope.namespaceId, grantedAtReadEpoch);
            }
            _lowerWriteDeadline(msg.sender, scope.namespaceId, expiresAt);
        }
        _storeCapability(
            capabilityId,
            Capability({
                owner: msg.sender,
                agentId: agentId,
                namespaceId: scope.namespaceId,
                permissions: scope.permissions,
                provenancePolicy: scope.provenancePolicy,
                issuedAt: uint64(block.timestamp),
                expiresAt: expiresAt,
                agentEpoch: _agentEpoch[msg.sender][agentId],
                grantedAtReadEpoch: grantedAtReadEpoch,
                revoked: false
            })
        );
        emit CapabilityGranted(
            msg.sender, agentId, scope.namespaceId, capabilityId, scope.permissions, scope.provenancePolicy, expiresAt, context
        );
    }
}
