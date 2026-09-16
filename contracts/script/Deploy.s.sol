// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {CapabilityRegistry} from "../src/CapabilityRegistry.sol";
import {ContextRegistry} from "../src/ContextRegistry.sol";
import {ICapabilityRegistry} from "../src/ICapabilityRegistry.sol";

/// @notice Deploys CapabilityRegistry then ContextRegistry and writes deployments/<chainId>.json for the
///         SDK, API and indexer. VAULT_RP_ID defaults to vault.mida.xyz.
///         forge script script/Deploy.s.sol --rpc-url <url> --broadcast --private-key <key>
contract Deploy is Script {
    function run() external returns (CapabilityRegistry capabilityRegistry, ContextRegistry contextRegistry) {
        string memory vaultRpId = vm.envOr("VAULT_RP_ID", string("vault.mida.xyz"));
        uint256 deploymentBlock = block.number;

        vm.startBroadcast();
        capabilityRegistry = new CapabilityRegistry(vaultRpId);
        contextRegistry = new ContextRegistry(ICapabilityRegistry(address(capabilityRegistry)));
        vm.stopBroadcast();

        string memory key = "deployment";
        vm.serializeUint(key, "chainId", block.chainid);
        vm.serializeUint(key, "deploymentBlock", deploymentBlock);
        vm.serializeString(key, "vaultRpId", vaultRpId);
        vm.serializeBytes32(key, "vaultRpIdHash", capabilityRegistry.VAULT_RP_ID_HASH());
        vm.serializeBytes32(key, "policyHashV1", capabilityRegistry.POLICY_HASH_V1());
        vm.serializeAddress(key, "capabilityRegistry", address(capabilityRegistry));
        string memory json = vm.serializeAddress(key, "contextRegistry", address(contextRegistry));
        string memory path = string.concat("deployments/", vm.toString(block.chainid), ".json");
        vm.writeJson(json, path);

        console2.log("CapabilityRegistry", address(capabilityRegistry));
        console2.log("ContextRegistry", address(contextRegistry));
        console2.log("wrote", path);
    }
}
