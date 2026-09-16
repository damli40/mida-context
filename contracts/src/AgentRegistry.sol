// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AgentRegistration} from "./MidaTypes.sol";
import {MidaHashing} from "./MidaHashing.sol";
import {SignatureRecovery} from "./SignatureRecovery.sol";

/// @notice Agent identities (spec §4.3) and capability-manifest commitments (spec §14.1).
///         agentId = keccak256(abi.encode("MIDA_AGENT_V1", chainId, registry, operator, agentSalt)).
///         The signer is a rotatable attribute and is not part of the identifier.
abstract contract AgentRegistry {
    struct AgentRecord {
        address operator;
        address signer;
        bytes32 encryptionPublicKey;
        uint32 encryptionKeyVersion;
        bytes32 callbackOriginHash;
        bytes32 capabilityManifestHash;
        uint64 capabilityManifestVersion;
        bool active;
    }

    error AgentNotFound(bytes32 agentId);
    error AgentAlreadyRegistered(bytes32 agentId);
    error NotOperator(bytes32 agentId);
    error SignerAlreadyBound(address signer);
    error InvalidSignature();
    error ZeroValue();
    error ManifestVersionInvalid(uint64 expected, uint64 submitted);

    mapping(bytes32 agentId => AgentRecord) private _agents;
    mapping(address signer => bytes32 agentId) private _agentIdBySigner;
    mapping(bytes32 agentId => uint64) public signerRotationNonce;

    event AgentRegistered(
        bytes32 indexed agentId,
        address indexed operator,
        address indexed signer,
        bytes32 encryptionPublicKey,
        uint32 encryptionKeyVersion,
        bytes32 callbackOriginHash,
        bytes32 capabilityManifestHash,
        uint64 capabilityManifestVersion
    );
    event AgentSigningKeyRotated(bytes32 indexed agentId, address indexed previousSigner, address indexed newSigner);
    event AgentEncryptionKeyRotated(bytes32 indexed agentId, bytes32 encryptionPublicKey, uint32 encryptionKeyVersion);
    event AgentOriginChanged(bytes32 indexed agentId, bytes32 callbackOriginHash);
    event AgentCapabilityManifestUpdated(
        bytes32 indexed agentId, bytes32 capabilityManifestHash, uint64 capabilityManifestVersion
    );

    /// @notice Called by the operator. The proposed signer must have signed MidaAgentRegistrationV1
    ///         over every field, with encryptionKeyVersion = 1 and capabilityManifestVersion = 1.
    function registerAgent(
        bytes32 agentSalt,
        address signer,
        bytes32 encryptionPublicKey,
        bytes32 callbackOriginHash,
        bytes32 capabilityManifestHash,
        bytes calldata signerSignature
    ) external returns (bytes32 agentId) {
        if (
            signer == address(0) || encryptionPublicKey == bytes32(0) || callbackOriginHash == bytes32(0)
                || capabilityManifestHash == bytes32(0)
        ) revert ZeroValue();
        agentId = MidaHashing.agentId(block.chainid, address(this), msg.sender, agentSalt);
        if (_agents[agentId].operator != address(0)) revert AgentAlreadyRegistered(agentId);
        if (_agentIdBySigner[signer] != bytes32(0)) revert SignerAlreadyBound(signer);

        AgentRegistration memory registration = AgentRegistration({
            agentId: agentId,
            operator: msg.sender,
            signer: signer,
            encryptionPublicKey: encryptionPublicKey,
            encryptionKeyVersion: 1,
            callbackOriginHash: callbackOriginHash,
            capabilityManifestHash: capabilityManifestHash,
            capabilityManifestVersion: 1
        });
        bytes32 digest = MidaHashing.agentRegistrationDigest(registration, block.chainid, address(this));
        if (SignatureRecovery.recover(digest, signerSignature) != signer) revert InvalidSignature();

        _agents[agentId] = AgentRecord({
            operator: msg.sender,
            signer: signer,
            encryptionPublicKey: encryptionPublicKey,
            encryptionKeyVersion: 1,
            callbackOriginHash: callbackOriginHash,
            capabilityManifestHash: capabilityManifestHash,
            capabilityManifestVersion: 1,
            active: true
        });
        _agentIdBySigner[signer] = agentId;
        emit AgentRegistered(
            agentId, msg.sender, signer, encryptionPublicKey, 1, callbackOriginHash, capabilityManifestHash, 1
        );
    }

    /// @notice Operator authority plus MidaSignerRotationV1 signed by the new signer.
    function rotateAgentSigner(bytes32 agentId, address newSigner, bytes calldata newSignerSignature) external {
        AgentRecord storage agent = _operatorAgent(agentId);
        if (newSigner == address(0)) revert ZeroValue();
        if (_agentIdBySigner[newSigner] != bytes32(0)) revert SignerAlreadyBound(newSigner);
        uint64 nonce = signerRotationNonce[agentId];
        bytes32 digest = MidaHashing.signerRotationDigest(agentId, newSigner, nonce, block.chainid, address(this));
        if (SignatureRecovery.recover(digest, newSignerSignature) != newSigner) revert InvalidSignature();

        signerRotationNonce[agentId] = nonce + 1;
        address previous = agent.signer;
        delete _agentIdBySigner[previous];
        _agentIdBySigner[newSigner] = agentId;
        agent.signer = newSigner;
        emit AgentSigningKeyRotated(agentId, previous, newSigner);
    }

    /// @notice Operator authority. Existing reader wraps for the old version become invalid.
    function rotateAgentEncryptionKey(bytes32 agentId, bytes32 newEncryptionPublicKey) external {
        AgentRecord storage agent = _operatorAgent(agentId);
        if (newEncryptionPublicKey == bytes32(0)) revert ZeroValue();
        agent.encryptionPublicKey = newEncryptionPublicKey;
        agent.encryptionKeyVersion += 1;
        emit AgentEncryptionKeyRotated(agentId, newEncryptionPublicKey, agent.encryptionKeyVersion);
    }

    function setAgentCallbackOrigin(bytes32 agentId, bytes32 newCallbackOriginHash) external {
        AgentRecord storage agent = _operatorAgent(agentId);
        if (newCallbackOriginHash == bytes32(0)) revert ZeroValue();
        agent.callbackOriginHash = newCallbackOriginHash;
        emit AgentOriginChanged(agentId, newCallbackOriginHash);
    }

    /// @notice Operator authority, the exact next version, and the operator's EIP-712 ManifestBinding
    ///         signature under the "Mida Agent Capability Manifest" domain for this chain and registry.
    function updateAgentCapabilityManifest(
        bytes32 agentId,
        bytes32 bodyHash,
        uint64 manifestVersion,
        bytes calldata operatorSignature
    ) external {
        AgentRecord storage agent = _operatorAgent(agentId);
        if (bodyHash == bytes32(0)) revert ZeroValue();
        uint64 expected = agent.capabilityManifestVersion + 1;
        if (manifestVersion != expected) revert ManifestVersionInvalid(expected, manifestVersion);
        bytes32 digest = MidaHashing.manifestBindingDigest(bodyHash, agentId, manifestVersion, block.chainid, address(this));
        if (SignatureRecovery.recover(digest, operatorSignature) != agent.operator) revert InvalidSignature();

        agent.capabilityManifestHash = bodyHash;
        agent.capabilityManifestVersion = manifestVersion;
        emit AgentCapabilityManifestUpdated(agentId, bodyHash, manifestVersion);
    }

    function getAgent(bytes32 agentId) external view returns (AgentRecord memory) {
        return _activeAgent(agentId);
    }

    /// @notice Returns bytes32(0) when the address is not the current signer of any agent.
    function agentIdOfSigner(address signer) public view returns (bytes32) {
        return _agentIdBySigner[signer];
    }

    function _activeAgent(bytes32 agentId) internal view returns (AgentRecord storage agent) {
        agent = _agents[agentId];
        if (!agent.active) revert AgentNotFound(agentId);
    }

    function _operatorAgent(bytes32 agentId) private view returns (AgentRecord storage agent) {
        agent = _activeAgent(agentId);
        if (agent.operator != msg.sender) revert NotOperator(agentId);
    }
}
