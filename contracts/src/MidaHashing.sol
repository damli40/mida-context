// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {
    AccessRequestInput,
    AgentRegistration,
    EvidenceRef,
    GrantDigestInput,
    GrantScope,
    NAMESPACE_TREE_VERSION_HASH,
    POLICY_VERSION_HASH
} from "./MidaTypes.sol";

/// @notice Every identifier and digest shared with the TypeScript protocol package (plan Task 5).
///         Chain ID and registry address are parameters so parity tests can reproduce fixed vectors.
library MidaHashing {
    bytes32 internal constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 internal constant ACCESS_REQUEST_TYPEHASH = keccak256(
        "MidaAccessRequestV1(bytes32 requestId,bytes32 nonce,bytes32 agentId,bytes32 purposeIdHash,bytes32 callbackOriginHash,bytes32 manifestHash,uint64 manifestVersion,bytes32 policyVersionHash,bytes32 namespaceTreeVersionHash,bytes32 scopesHash,uint64 issuedAt,uint64 requestExpiresAt,uint64 capabilityExpiresAt)"
    );
    bytes32 internal constant MANIFEST_BINDING_TYPEHASH =
        keccak256("ManifestBinding(bytes32 bodyHash,bytes32 agentId,uint64 manifestVersion)");
    bytes32 internal constant HTTP_REQUEST_TYPEHASH = keccak256(
        "MidaHttpRequestV1(address signer,bytes32 methodHash,bytes32 targetHash,bytes32 bodyHash,uint64 timestamp,bytes32 nonce)"
    );
    bytes32 internal constant AGENT_REGISTRATION_TYPEHASH = keccak256(
        "MidaAgentRegistrationV1(bytes32 agentId,address operator,address signer,bytes32 encryptionPublicKey,uint32 encryptionKeyVersion,bytes32 callbackOriginHash,bytes32 capabilityManifestHash,uint64 capabilityManifestVersion)"
    );
    bytes32 internal constant SIGNER_ROTATION_TYPEHASH =
        keccak256("MidaSignerRotationV1(bytes32 agentId,address newSigner,uint64 rotationNonce)");

    string internal constant DOMAIN_CAPABILITY_REGISTRY = "Mida Capability Registry";
    string internal constant DOMAIN_ACCESS_REQUEST = "Mida Context";
    string internal constant DOMAIN_MANIFEST = "Mida Agent Capability Manifest";
    string internal constant DOMAIN_HTTP_REQUEST = "Mida Context API";

    function namespaceId(string memory canonicalName) internal pure returns (bytes32) {
        return keccak256(abi.encode(string("MIDA_NAMESPACE_V1"), canonicalName));
    }

    function agentId(uint256 chainId, address registry, address operator, bytes32 agentSalt)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(string("MIDA_AGENT_V1"), chainId, registry, operator, agentSalt));
    }

    function contextId(
        uint256 chainId,
        address contextRegistry,
        address owner,
        bytes32 authorId,
        bytes32 namespaceId_,
        bytes32 objectNonce
    ) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(string("MIDA_CONTEXT_OBJECT_V1"), chainId, contextRegistry, owner, authorId, namespaceId_, objectNonce)
        );
    }

    function scopesHash(GrantScope[] memory scopes) internal pure returns (bytes32) {
        return keccak256(abi.encode(scopes));
    }

    function capabilityId(
        address owner,
        bytes32 agentId_,
        uint256 grantNonce,
        uint256 index,
        GrantScope memory scope,
        uint64 expiresAt
    ) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                string("MIDA_CAPABILITY_V1"),
                owner,
                agentId_,
                grantNonce,
                index,
                scope.namespaceId,
                scope.permissions,
                scope.provenancePolicy,
                expiresAt
            )
        );
    }

    function grantDigest(GrantDigestInput memory g) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                string("MIDA_GRANT_V1"),
                g.chainId,
                g.capabilityRegistry,
                g.owner,
                g.agentId,
                g.requestHash,
                g.manifestHash,
                g.manifestVersion,
                POLICY_VERSION_HASH,
                NAMESPACE_TREE_VERSION_HASH,
                g.scopesHash,
                g.expiresAt,
                g.grantNonce
            )
        );
    }

    function evidenceCommitment(EvidenceRef[] memory canonicalRefs) internal pure returns (bytes32) {
        return keccak256(abi.encode(string("MIDA_EVIDENCE_V1"), canonicalRefs));
    }

    function p256RotationDigest(uint256 chainId, address registry, address owner, uint256 newQx, uint256 newQy, uint256 nonce)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(string("MIDA_ROTATE_P256_V1"), chainId, registry, owner, newQx, newQy, nonce));
    }

    function domainSeparator(string memory name, uint256 chainId, address verifyingContract)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(EIP712_DOMAIN_TYPEHASH, keccak256(bytes(name)), keccak256("1"), chainId, verifyingContract));
    }

    function typedDigest(bytes32 separator, bytes32 structHash) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(hex"1901", separator, structHash));
    }

    function accessRequestDigest(AccessRequestInput memory r, uint256 chainId, address registry)
        internal
        pure
        returns (bytes32)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                ACCESS_REQUEST_TYPEHASH,
                r.requestId,
                r.nonce,
                r.agentId,
                r.purposeIdHash,
                r.callbackOriginHash,
                r.manifestHash,
                r.manifestVersion,
                r.policyVersionHash,
                r.namespaceTreeVersionHash,
                scopesHash(r.scopes),
                r.issuedAt,
                r.requestExpiresAt,
                r.capabilityExpiresAt
            )
        );
        return typedDigest(domainSeparator(DOMAIN_ACCESS_REQUEST, chainId, registry), structHash);
    }

    function manifestBindingDigest(bytes32 bodyHash, bytes32 agentId_, uint64 manifestVersion, uint256 chainId, address registry)
        internal
        pure
        returns (bytes32)
    {
        return typedDigest(
            domainSeparator(DOMAIN_MANIFEST, chainId, registry),
            keccak256(abi.encode(MANIFEST_BINDING_TYPEHASH, bodyHash, agentId_, manifestVersion))
        );
    }

    function httpRequestDigest(
        address signer,
        bytes32 methodHash,
        bytes32 targetHash,
        bytes32 bodyHash,
        uint64 timestamp,
        bytes32 nonce,
        uint256 chainId,
        address registry
    ) internal pure returns (bytes32) {
        return typedDigest(
            domainSeparator(DOMAIN_HTTP_REQUEST, chainId, registry),
            keccak256(abi.encode(HTTP_REQUEST_TYPEHASH, signer, methodHash, targetHash, bodyHash, timestamp, nonce))
        );
    }

    function agentRegistrationDigest(AgentRegistration memory a, uint256 chainId, address registry)
        internal
        pure
        returns (bytes32)
    {
        return typedDigest(
            domainSeparator(DOMAIN_CAPABILITY_REGISTRY, chainId, registry),
            keccak256(
                abi.encode(
                    AGENT_REGISTRATION_TYPEHASH,
                    a.agentId,
                    a.operator,
                    a.signer,
                    a.encryptionPublicKey,
                    a.encryptionKeyVersion,
                    a.callbackOriginHash,
                    a.capabilityManifestHash,
                    a.capabilityManifestVersion
                )
            )
        );
    }

    function signerRotationDigest(bytes32 agentId_, address newSigner, uint64 rotationNonce, uint256 chainId, address registry)
        internal
        pure
        returns (bytes32)
    {
        return typedDigest(
            domainSeparator(DOMAIN_CAPABILITY_REGISTRY, chainId, registry),
            keccak256(abi.encode(SIGNER_ROTATION_TYPEHASH, agentId_, newSigner, rotationNonce))
        );
    }
}
