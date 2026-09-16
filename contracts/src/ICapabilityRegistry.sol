// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice The CapabilityRegistry views ContextRegistry depends on. ContextRegistry never writes to it.
interface ICapabilityRegistry {
    function isRegisteredNamespace(bytes32 namespaceId) external view returns (bool);
    function agentIdOfSigner(address signer) external view returns (bytes32);
    function requiredReadEpoch(address owner, bytes32 namespaceId) external view returns (uint64);
    function epochPublicKey(address owner, bytes32 namespaceId, uint64 epoch) external view returns (bytes32);
    function isWriteEpochValid(address owner, bytes32 namespaceId, uint64 epoch) external view returns (bool);
    function hasAuthority(address owner, bytes32 agentId, bytes32 namespaceId, uint8 permissions, uint8 provenanceBits)
        external
        view
        returns (bool);
}
