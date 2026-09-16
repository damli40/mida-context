// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {AgentRegistration} from "../../src/MidaTypes.sol";
import {MidaHashing} from "../../src/MidaHashing.sol";
import {CapabilityRegistry} from "../../src/CapabilityRegistry.sol";

/// @notice Shared agent setup for registry tests. Keys are Foundry test keys, never real secrets.
abstract contract AgentFixtures is Test {
    struct TestAgent {
        bytes32 agentId;
        uint256 operatorKey;
        address operator;
        uint256 signerKey;
        address signer;
        bytes32 encryptionPublicKey;
        bytes32 callbackOriginHash;
        bytes32 manifestHash;
    }

    function _sign(uint256 privateKey, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digest);
        return abi.encodePacked(r, s, v);
    }

    function _newAgent(string memory label) internal returns (TestAgent memory agent) {
        (agent.operator, agent.operatorKey) = makeAddrAndKey(string.concat(label, ".operator"));
        (agent.signer, agent.signerKey) = makeAddrAndKey(string.concat(label, ".signer"));
        agent.encryptionPublicKey = keccak256(abi.encode(label, "x25519"));
        agent.callbackOriginHash = keccak256(bytes(string.concat("https://", label, ".example")));
        agent.manifestHash = keccak256(abi.encode(label, "manifest", uint64(1)));
    }

    function _registrationSignature(CapabilityRegistry registry, TestAgent memory agent, bytes32 salt, uint256 signingKey)
        internal
        view
        returns (bytes32 agentId, bytes memory signature)
    {
        agentId = MidaHashing.agentId(block.chainid, address(registry), agent.operator, salt);
        AgentRegistration memory registration = AgentRegistration({
            agentId: agentId,
            operator: agent.operator,
            signer: agent.signer,
            encryptionPublicKey: agent.encryptionPublicKey,
            encryptionKeyVersion: 1,
            callbackOriginHash: agent.callbackOriginHash,
            capabilityManifestHash: agent.manifestHash,
            capabilityManifestVersion: 1
        });
        signature = _sign(signingKey, MidaHashing.agentRegistrationDigest(registration, block.chainid, address(registry)));
    }

    function _register(CapabilityRegistry registry, string memory label) internal returns (TestAgent memory agent) {
        agent = _newAgent(label);
        bytes32 salt = keccak256(abi.encode(label, "salt"));
        bytes memory signature;
        (agent.agentId, signature) = _registrationSignature(registry, agent, salt, agent.signerKey);
        vm.prank(agent.operator);
        registry.registerAgent(
            salt, agent.signer, agent.encryptionPublicKey, agent.callbackOriginHash, agent.manifestHash, signature
        );
    }
}
