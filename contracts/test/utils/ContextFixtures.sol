// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {LINEAGE_STANDARD, RECORD_CONTEXT, RECORD_EVIDENCE} from "../../src/MidaTypes.sol";
import {ContextRegistry} from "../../src/ContextRegistry.sol";
import {ICapabilityRegistry} from "../../src/ICapabilityRegistry.sol";
import {MidaHashing} from "../../src/MidaHashing.sol";
import {GrantFixtures} from "./GrantFixtures.sol";

/// @notice Builds ContextInput values exactly as the SDK will: contextId is recomputed from
///         (chain, ContextRegistry, owner, author, namespace, nonce) before submission.
abstract contract ContextFixtures is GrantFixtures {
    ContextRegistry internal contexts;

    function _deployContexts() internal {
        _deployRegistry();
        contexts = new ContextRegistry(ICapabilityRegistry(address(registry)));
    }

    function _contextInput(
        address owner,
        bytes32 authorId,
        string memory namespaceName,
        string memory nonceLabel,
        uint8 kind,
        uint8 provenanceSource
    ) internal view returns (ContextRegistry.ContextInput memory input) {
        input.objectNonce = keccak256(bytes(nonceLabel));
        input.namespaceId = _ns(namespaceName);
        input.contextId = MidaHashing.contextId(
            block.chainid, address(contexts), owner, authorId, input.namespaceId, input.objectNonce
        );
        input.manifestHash = keccak256(abi.encode(nonceLabel, "manifest"));
        input.ciphertextCommitment = sha256(abi.encode(nonceLabel, "ciphertext"));
        input.readEpoch = registry.requiredReadEpoch(owner, input.namespaceId);
        input.recordType = RECORD_CONTEXT;
        input.lineagePolicy = LINEAGE_STANDARD;
        input.kind = kind;
        input.provenanceSource = provenanceSource;
    }

    function _evidenceInput(address owner, bytes32 authorId, string memory namespaceName, string memory nonceLabel)
        internal
        view
        returns (ContextRegistry.ContextInput memory input)
    {
        input = _contextInput(owner, authorId, namespaceName, nonceLabel, 0, 0);
        input.recordType = RECORD_EVIDENCE;
    }

    function _batch(ContextRegistry.ContextInput memory input)
        internal
        pure
        returns (ContextRegistry.ContextInput[] memory inputs)
    {
        inputs = new ContextRegistry.ContextInput[](1);
        inputs[0] = input;
    }

    function _submit(address sender, address owner, ContextRegistry.ContextInput memory input) internal returns (bytes32) {
        vm.prank(sender);
        return contexts.register(owner, _batch(input))[0];
    }

    function _expectSubmitRevert(address sender, address owner, ContextRegistry.ContextInput memory input, bytes memory revertData)
        internal
    {
        ContextRegistry.ContextInput[] memory inputs = _batch(input);
        vm.prank(sender);
        vm.expectRevert(revertData);
        contexts.register(owner, inputs);
    }
}
