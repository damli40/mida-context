// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {BatchAnchor} from "../src/BatchAnchor.sol";
import {ICapabilityRegistry} from "../src/ICapabilityRegistry.sol";

/// @notice Deploys BatchAnchor beside an EXISTING deployment (never redeploys the registries) and adds
///         batchAnchor + batchAnchorBlock to deployments/<chainId>.json, keeping every other key.
contract DeployBatchAnchor is Script {
    function run() external returns (BatchAnchor anchor) {
        string memory path = string.concat("deployments/", vm.toString(block.chainid), ".json");
        address capabilityRegistry = vm.parseJsonAddress(vm.readFile(path), ".capabilityRegistry");
        uint256 deploymentBlock = block.number;

        vm.startBroadcast();
        anchor = new BatchAnchor(ICapabilityRegistry(capabilityRegistry));
        vm.stopBroadcast();

        vm.writeJson(vm.toString(address(anchor)), path, ".batchAnchor");
        vm.writeJson(vm.toString(deploymentBlock), path, ".batchAnchorBlock");
        console2.log("BatchAnchor", address(anchor));
    }
}
