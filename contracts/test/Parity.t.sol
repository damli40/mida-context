// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {
    AccessRequestInput,
    AgentRegistration,
    EvidenceRef,
    GrantDigestInput,
    GrantScope,
    NAMESPACE_TREE_VERSION_HASH,
    POLICY_VERSION_HASH
} from "../src/MidaTypes.sol";
import {MidaHashing} from "../src/MidaHashing.sol";

/// @notice Every identifier and EIP-712 digest must equal the TypeScript vectors exported by
///         packages/protocol/scripts/export-vectors.ts. A failure here means the two layers drifted.
contract ParityTest is Test {
    string internal ids;

    function setUp() public {
        ids = vm.readFile("test/vectors/ids-v1.json");
    }

    function _b32(string memory key) internal view returns (bytes32) {
        return vm.parseJsonBytes32(ids, string.concat(".", key));
    }

    function _addr(string memory key) internal view returns (address) {
        return vm.parseJsonAddress(ids, string.concat(".", key));
    }

    function _chainId() internal view returns (uint256) {
        return vm.parseJsonUint(ids, ".chainId");
    }

    function _registry() internal view returns (address) {
        return _addr("capabilityRegistry");
    }

    function _scopes() internal view returns (GrantScope[] memory scopes) {
        bytes32[] memory namespaceIds = vm.parseJsonBytes32Array(ids, ".scopeNamespaceIds");
        uint256[] memory permissions = vm.parseJsonUintArray(ids, ".scopePermissions");
        uint256[] memory provenance = vm.parseJsonUintArray(ids, ".scopeProvenancePolicies");
        scopes = new GrantScope[](namespaceIds.length);
        for (uint256 i = 0; i < namespaceIds.length; i++) {
            scopes[i] = GrantScope(namespaceIds[i], uint8(permissions[i]), uint8(provenance[i]));
        }
    }

    function test_versionHashes() public view {
        assertEq(POLICY_VERSION_HASH, _b32("policyVersionHash"));
        assertEq(NAMESPACE_TREE_VERSION_HASH, _b32("namespaceTreeVersionHash"));
    }

    function test_namespaceIdsInTreeOrder() public view {
        string[] memory names = vm.parseJsonStringArray(ids, ".namespaceNames");
        bytes32[] memory expected = vm.parseJsonBytes32Array(ids, ".namespaceIds");
        assertEq(names.length, 22);
        assertEq(expected.length, 22);
        for (uint256 i = 0; i < names.length; i++) {
            assertEq(MidaHashing.namespaceId(names[i]), expected[i], names[i]);
        }
    }

    function test_agentId() public view {
        assertEq(MidaHashing.agentId(_chainId(), _registry(), _addr("operator"), _b32("c32")), _b32("agentId"));
    }

    function test_contextId() public view {
        bytes32 careerId = MidaHashing.namespaceId("goals.career");
        assertEq(
            MidaHashing.contextId(_chainId(), _addr("contextRegistry"), _addr("owner"), _b32("a32"), careerId, _b32("b32")),
            _b32("contextId")
        );
    }

    function test_scopesHash() public view {
        assertEq(MidaHashing.scopesHash(_scopes()), _b32("scopesHash"));
    }

    function test_capabilityId() public view {
        GrantScope memory first = _scopes()[0];
        assertEq(MidaHashing.capabilityId(_addr("owner"), _b32("a32"), 3, 1, first, 86_400), _b32("capabilityId"));
    }

    function test_grantDigest() public view {
        GrantDigestInput memory input = GrantDigestInput({
            chainId: _chainId(),
            capabilityRegistry: _registry(),
            owner: _addr("owner"),
            agentId: _b32("a32"),
            requestHash: _b32("b32"),
            manifestHash: _b32("c32"),
            manifestVersion: 2,
            scopesHash: MidaHashing.scopesHash(_scopes()),
            expiresAt: 7_000,
            grantNonce: 9
        });
        assertEq(MidaHashing.grantDigest(input), _b32("grantDigest"));
    }

    function test_evidenceCommitment() public view {
        uint256[] memory relations = vm.parseJsonUintArray(ids, ".evidenceRelations");
        bytes32[] memory recordIds = vm.parseJsonBytes32Array(ids, ".evidenceRecordIds");
        EvidenceRef[] memory refs = new EvidenceRef[](relations.length);
        for (uint256 i = 0; i < relations.length; i++) {
            refs[i] = EvidenceRef(uint8(relations[i]), recordIds[i]);
        }
        assertEq(MidaHashing.evidenceCommitment(refs), _b32("evidenceCommitment"));
    }

    function test_p256RotationDigest() public view {
        assertEq(
            MidaHashing.p256RotationDigest(
                _chainId(), _registry(), _addr("owner"), uint256(_b32("p256Qx")), uint256(_b32("p256Qy")), 4
            ),
            _b32("p256RotationDigest")
        );
    }

    function test_accessRequestDigest() public view {
        AccessRequestInput memory request;
        request.requestId = _b32("a32");
        request.nonce = _b32("b32");
        request.agentId = _b32("c32");
        request.purposeIdHash = keccak256("career_coaching");
        request.callbackOriginHash = keccak256("https://career.example");
        request.manifestHash = _b32("d32");
        request.manifestVersion = 1;
        request.policyVersionHash = POLICY_VERSION_HASH;
        request.namespaceTreeVersionHash = NAMESPACE_TREE_VERSION_HASH;
        request.issuedAt = 1000;
        request.requestExpiresAt = 1600;
        request.capabilityExpiresAt = 0;
        request.scopes = _scopes();
        assertEq(request.purposeIdHash, _b32("accessRequestPurposeIdHash"));
        assertEq(request.callbackOriginHash, _b32("accessRequestCallbackOriginHash"));
        assertEq(MidaHashing.accessRequestDigest(request, _chainId(), _registry()), _b32("accessRequestDigest"));
    }

    function test_manifestBindingDigest() public view {
        assertEq(
            MidaHashing.manifestBindingDigest(_b32("a32"), _b32("c32"), 3, _chainId(), _registry()),
            _b32("manifestBindingDigest")
        );
    }

    function test_httpRequestDigest() public view {
        assertEq(keccak256("POST"), _b32("httpMethodHash"));
        assertEq(keccak256("/objects"), _b32("httpTargetHash"));
        assertEq(keccak256("{}"), _b32("httpBodyHash"));
        assertEq(
            MidaHashing.httpRequestDigest(
                _addr("owner"),
                keccak256("POST"),
                keccak256("/objects"),
                keccak256("{}"),
                1_700_000_000,
                _b32("b32"),
                _chainId(),
                _registry()
            ),
            _b32("httpRequestDigest")
        );
    }

    function test_agentRegistrationDigest() public view {
        AgentRegistration memory registration = AgentRegistration({
            agentId: _b32("c32"),
            operator: _addr("operator"),
            signer: _addr("signer"),
            encryptionPublicKey: _b32("d32"),
            encryptionKeyVersion: 1,
            callbackOriginHash: _b32("agentRegistrationOriginHash"),
            capabilityManifestHash: _b32("a32"),
            capabilityManifestVersion: 1
        });
        assertEq(
            MidaHashing.agentRegistrationDigest(registration, _chainId(), _registry()), _b32("agentRegistrationDigest")
        );
    }

    function test_signerRotationDigest() public view {
        assertEq(
            MidaHashing.signerRotationDigest(_b32("c32"), _addr("signer"), 5, _chainId(), _registry()),
            _b32("signerRotationDigest")
        );
    }
}
