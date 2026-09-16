// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {MidaHashing} from "../src/MidaHashing.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";
import {CapabilityRegistry} from "../src/CapabilityRegistry.sol";
import {AgentFixtures} from "./utils/AgentFixtures.sol";

/// @notice §15 Identity rows and contract-side Advisor manifest rows.
contract AgentRegistryTest is AgentFixtures {
    CapabilityRegistry internal registry;

    function setUp() public {
        registry = new CapabilityRegistry("vault.mida.xyz");
    }

    function test_registerStoresRecordAndEmits() public {
        TestAgent memory agent = _newAgent("career");
        bytes32 salt = keccak256("career.salt");
        (bytes32 expectedId, bytes memory signature) = _registrationSignature(registry, agent, salt, agent.signerKey);

        vm.expectEmit(address(registry));
        emit AgentRegistry.AgentRegistered(
            expectedId, agent.operator, agent.signer, agent.encryptionPublicKey, 1, agent.callbackOriginHash, agent.manifestHash, 1
        );
        vm.prank(agent.operator);
        bytes32 agentId = registry.registerAgent(
            salt, agent.signer, agent.encryptionPublicKey, agent.callbackOriginHash, agent.manifestHash, signature
        );

        assertEq(agentId, expectedId);
        AgentRegistry.AgentRecord memory record = registry.getAgent(agentId);
        assertEq(record.operator, agent.operator);
        assertEq(record.signer, agent.signer);
        assertEq(record.encryptionPublicKey, agent.encryptionPublicKey);
        assertEq(record.encryptionKeyVersion, 1);
        assertEq(record.callbackOriginHash, agent.callbackOriginHash);
        assertEq(record.capabilityManifestHash, agent.manifestHash);
        assertEq(record.capabilityManifestVersion, 1);
        assertTrue(record.active);
        assertEq(registry.agentIdOfSigner(agent.signer), agentId);
    }

    /// @dev §15 "register an agent without signer acceptance proof".
    function test_registrationWithoutSignerProofRejected() public {
        TestAgent memory agent = _newAgent("career");
        bytes32 salt = keccak256("career.salt");
        (, bytes memory operatorSigned) = _registrationSignature(registry, agent, salt, agent.operatorKey);
        vm.prank(agent.operator);
        vm.expectRevert(AgentRegistry.InvalidSignature.selector);
        registry.registerAgent(
            salt, agent.signer, agent.encryptionPublicKey, agent.callbackOriginHash, agent.manifestHash, operatorSigned
        );
    }

    function test_registrationSignatureBoundToChainAndRegistry() public {
        TestAgent memory agent = _newAgent("career");
        bytes32 salt = keccak256("career.salt");
        CapabilityRegistry other = new CapabilityRegistry("vault.mida.xyz");
        (, bytes memory forOtherRegistry) = _registrationSignature(other, agent, salt, agent.signerKey);
        vm.prank(agent.operator);
        vm.expectRevert(AgentRegistry.InvalidSignature.selector);
        registry.registerAgent(
            salt, agent.signer, agent.encryptionPublicKey, agent.callbackOriginHash, agent.manifestHash, forOtherRegistry
        );

        (, bytes memory forThisChain) = _registrationSignature(registry, agent, salt, agent.signerKey);
        vm.chainId(10143);
        vm.prank(agent.operator);
        vm.expectRevert(AgentRegistry.InvalidSignature.selector);
        registry.registerAgent(
            salt, agent.signer, agent.encryptionPublicKey, agent.callbackOriginHash, agent.manifestHash, forThisChain
        );
    }

    function test_registrationSignatureCannotBeMutated() public {
        TestAgent memory agent = _newAgent("career");
        bytes32 salt = keccak256("career.salt");
        (, bytes memory signature) = _registrationSignature(registry, agent, salt, agent.signerKey);
        vm.prank(agent.operator);
        vm.expectRevert(AgentRegistry.InvalidSignature.selector);
        registry.registerAgent(
            salt, agent.signer, keccak256("different key"), agent.callbackOriginHash, agent.manifestHash, signature
        );
    }

    function test_duplicateAgentIdRejected() public {
        TestAgent memory agent = _register(registry, "career");
        TestAgent memory again = _newAgent("career");
        (again.signer, again.signerKey) = makeAddrAndKey("career.second-signer");
        bytes32 salt = keccak256(abi.encode("career", "salt"));
        (, bytes memory signature) = _registrationSignature(registry, again, salt, again.signerKey);
        vm.prank(agent.operator);
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.AgentAlreadyRegistered.selector, agent.agentId));
        registry.registerAgent(salt, again.signer, again.encryptionPublicKey, again.callbackOriginHash, again.manifestHash, signature);
    }

    /// @dev §15 "reuse one active signer for another agent ID".
    function test_signerCannotBindTwoAgents() public {
        TestAgent memory first = _register(registry, "career");
        TestAgent memory second = _newAgent("travel");
        second.signer = first.signer;
        second.signerKey = first.signerKey;
        bytes32 salt = keccak256("travel.salt");
        (, bytes memory signature) = _registrationSignature(registry, second, salt, second.signerKey);
        vm.prank(second.operator);
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.SignerAlreadyBound.selector, first.signer));
        registry.registerAgent(salt, second.signer, second.encryptionPublicKey, second.callbackOriginHash, second.manifestHash, signature);
    }

    function test_zeroValuesRejected() public {
        TestAgent memory agent = _newAgent("career");
        vm.startPrank(agent.operator);
        vm.expectRevert(AgentRegistry.ZeroValue.selector);
        registry.registerAgent(bytes32(0), address(0), agent.encryptionPublicKey, agent.callbackOriginHash, agent.manifestHash, "");
        vm.expectRevert(AgentRegistry.ZeroValue.selector);
        registry.registerAgent(bytes32(0), agent.signer, bytes32(0), agent.callbackOriginHash, agent.manifestHash, "");
        vm.expectRevert(AgentRegistry.ZeroValue.selector);
        registry.registerAgent(bytes32(0), agent.signer, agent.encryptionPublicKey, agent.callbackOriginHash, bytes32(0), "");
        vm.stopPrank();
    }

    function test_unknownAgentReverts() public {
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.AgentNotFound.selector, bytes32(uint256(7))));
        registry.getAgent(bytes32(uint256(7)));
    }

    function _rotationSignature(bytes32 agentId, address newSigner, uint64 nonce, uint256 key) internal view returns (bytes memory) {
        return _sign(key, MidaHashing.signerRotationDigest(agentId, newSigner, nonce, block.chainid, address(registry)));
    }

    function test_signerRotationMovesBindingAndEmits() public {
        TestAgent memory agent = _register(registry, "career");
        (address newSigner, uint256 newKey) = makeAddrAndKey("career.rotated");
        bytes memory proof = _rotationSignature(agent.agentId, newSigner, 0, newKey);

        vm.expectEmit(address(registry));
        emit AgentRegistry.AgentSigningKeyRotated(agent.agentId, agent.signer, newSigner);
        vm.prank(agent.operator);
        registry.rotateAgentSigner(agent.agentId, newSigner, proof);

        assertEq(registry.getAgent(agent.agentId).signer, newSigner);
        assertEq(registry.agentIdOfSigner(newSigner), agent.agentId);
        assertEq(registry.agentIdOfSigner(agent.signer), bytes32(0));
        assertEq(registry.signerRotationNonce(agent.agentId), 1);
    }

    /// @dev §15 "signing-key rotation lacks new-signer proof".
    function test_signerRotationRequiresNewSignerProof() public {
        TestAgent memory agent = _register(registry, "career");
        (address newSigner,) = makeAddrAndKey("career.rotated");
        bytes memory oldSignerProof = _rotationSignature(agent.agentId, newSigner, 0, agent.signerKey);
        vm.prank(agent.operator);
        vm.expectRevert(AgentRegistry.InvalidSignature.selector);
        registry.rotateAgentSigner(agent.agentId, newSigner, oldSignerProof);
    }

    function test_signerRotationProofCannotBeReplayed() public {
        TestAgent memory agent = _register(registry, "career");
        (address newSigner, uint256 newKey) = makeAddrAndKey("career.rotated");
        bytes memory proof = _rotationSignature(agent.agentId, newSigner, 0, newKey);
        vm.startPrank(agent.operator);
        registry.rotateAgentSigner(agent.agentId, newSigner, proof);
        registry.rotateAgentSigner(agent.agentId, agent.signer, _rotationSignature(agent.agentId, agent.signer, 1, agent.signerKey));
        vm.expectRevert(AgentRegistry.InvalidSignature.selector);
        registry.rotateAgentSigner(agent.agentId, newSigner, proof);
        vm.stopPrank();
    }

    function test_signerRotationRejectsSignerBoundElsewhere() public {
        TestAgent memory career = _register(registry, "career");
        TestAgent memory travel = _register(registry, "travel");
        bytes memory proof = _rotationSignature(career.agentId, travel.signer, 0, travel.signerKey);
        vm.prank(career.operator);
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.SignerAlreadyBound.selector, travel.signer));
        registry.rotateAgentSigner(career.agentId, travel.signer, proof);
    }

    /// @dev §15 "non-operator rotates agent key".
    function test_nonOperatorCannotChangeAgent() public {
        TestAgent memory agent = _register(registry, "career");
        (address newSigner, uint256 newKey) = makeAddrAndKey("career.rotated");
        bytes memory proof = _rotationSignature(agent.agentId, newSigner, 0, newKey);
        bytes memory notOperator = abi.encodeWithSelector(AgentRegistry.NotOperator.selector, agent.agentId);

        vm.startPrank(agent.signer);
        vm.expectRevert(notOperator);
        registry.rotateAgentSigner(agent.agentId, newSigner, proof);
        vm.expectRevert(notOperator);
        registry.rotateAgentEncryptionKey(agent.agentId, keccak256("new key"));
        vm.expectRevert(notOperator);
        registry.setAgentCallbackOrigin(agent.agentId, keccak256("https://evil.example"));
        vm.expectRevert(notOperator);
        registry.updateAgentCapabilityManifest(agent.agentId, keccak256("body"), 2, "");
        vm.stopPrank();
    }

    function test_encryptionRotationIncrementsVersion() public {
        TestAgent memory agent = _register(registry, "career");
        bytes32 newKey = keccak256("career.x25519.v2");
        vm.expectEmit(address(registry));
        emit AgentRegistry.AgentEncryptionKeyRotated(agent.agentId, newKey, 2);
        vm.prank(agent.operator);
        registry.rotateAgentEncryptionKey(agent.agentId, newKey);
        AgentRegistry.AgentRecord memory record = registry.getAgent(agent.agentId);
        assertEq(record.encryptionPublicKey, newKey);
        assertEq(record.encryptionKeyVersion, 2);
    }

    function test_callbackOriginChangeEmits() public {
        TestAgent memory agent = _register(registry, "career");
        bytes32 newOrigin = keccak256("https://career-v2.example");
        vm.expectEmit(address(registry));
        emit AgentRegistry.AgentOriginChanged(agent.agentId, newOrigin);
        vm.prank(agent.operator);
        registry.setAgentCallbackOrigin(agent.agentId, newOrigin);
        assertEq(registry.getAgent(agent.agentId).callbackOriginHash, newOrigin);
    }

    function _manifestSignature(bytes32 agentId, bytes32 bodyHash, uint64 version, uint256 key, uint256 chainId, address reg)
        internal
        pure
        returns (bytes memory)
    {
        return _sign(key, MidaHashing.manifestBindingDigest(bodyHash, agentId, version, chainId, reg));
    }

    function test_manifestUpdateAdvancesExactlyOneVersion() public {
        TestAgent memory agent = _register(registry, "career");
        bytes32 body = keccak256("manifest body v2");
        bytes memory signature = _manifestSignature(agent.agentId, body, 2, agent.operatorKey, block.chainid, address(registry));
        vm.expectEmit(address(registry));
        emit AgentRegistry.AgentCapabilityManifestUpdated(agent.agentId, body, 2);
        vm.prank(agent.operator);
        registry.updateAgentCapabilityManifest(agent.agentId, body, 2, signature);
        AgentRegistry.AgentRecord memory record = registry.getAgent(agent.agentId);
        assertEq(record.capabilityManifestHash, body);
        assertEq(record.capabilityManifestVersion, 2);
    }

    /// @dev §15 "non-operator or skipped/replayed manifest version update".
    function test_manifestUpdateRejectsSkippedAndReplayedVersions() public {
        TestAgent memory agent = _register(registry, "career");
        bytes32 body = keccak256("manifest body");
        vm.startPrank(agent.operator);
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.ManifestVersionInvalid.selector, uint64(2), uint64(3)));
        registry.updateAgentCapabilityManifest(
            agent.agentId, body, 3, _manifestSignature(agent.agentId, body, 3, agent.operatorKey, block.chainid, address(registry))
        );
        vm.expectRevert(abi.encodeWithSelector(AgentRegistry.ManifestVersionInvalid.selector, uint64(2), uint64(1)));
        registry.updateAgentCapabilityManifest(
            agent.agentId, body, 1, _manifestSignature(agent.agentId, body, 1, agent.operatorKey, block.chainid, address(registry))
        );
        vm.stopPrank();
    }

    function test_manifestUpdateRequiresOperatorSignature() public {
        TestAgent memory agent = _register(registry, "career");
        bytes32 body = keccak256("manifest body v2");
        vm.prank(agent.operator);
        vm.expectRevert(AgentRegistry.InvalidSignature.selector);
        registry.updateAgentCapabilityManifest(
            agent.agentId, body, 2, _manifestSignature(agent.agentId, body, 2, agent.signerKey, block.chainid, address(registry))
        );
    }

    /// @dev §15 "use manifest envelope from another chain/registry".
    function test_manifestSignatureBoundToChainAndRegistry() public {
        TestAgent memory agent = _register(registry, "career");
        bytes32 body = keccak256("manifest body v2");
        vm.startPrank(agent.operator);
        vm.expectRevert(AgentRegistry.InvalidSignature.selector);
        registry.updateAgentCapabilityManifest(
            agent.agentId, body, 2, _manifestSignature(agent.agentId, body, 2, agent.operatorKey, 10143, address(registry))
        );
        vm.expectRevert(AgentRegistry.InvalidSignature.selector);
        registry.updateAgentCapabilityManifest(
            agent.agentId, body, 2, _manifestSignature(agent.agentId, body, 2, agent.operatorKey, block.chainid, address(0xBEEF))
        );
        vm.stopPrank();
    }
}
