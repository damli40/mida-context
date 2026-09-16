// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {InvalidNamespace} from "../src/MidaTypes.sol";
import {MidaHashing} from "../src/MidaHashing.sol";
import {NamespaceTree} from "../src/NamespaceTree.sol";

contract TreeHarness is NamespaceTree {}

contract NamespaceTreeTest is Test {
    TreeHarness internal tree;

    function setUp() public {
        tree = new TreeHarness();
    }

    function _names() internal view returns (string[] memory) {
        return vm.parseJsonStringArray(vm.readFile("test/vectors/ids-v1.json"), ".namespaceNames");
    }

    function test_registersAll22NodesInTypeScriptOrder() public {
        vm.recordLogs();
        TreeHarness fresh = new TreeHarness();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        string[] memory names = _names();
        bytes32 topic = keccak256("NamespaceRegistered(bytes32,bytes32,string,bool)");
        uint256 seen;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter != address(fresh) || logs[i].topics[0] != topic) continue;
            assertEq(logs[i].topics[1], MidaHashing.namespaceId(names[seen]), names[seen]);
            seen++;
        }
        assertEq(seen, 22);
        assertEq(fresh.NAMESPACE_COUNT(), 22);
        for (uint256 i = 0; i < names.length; i++) {
            assertTrue(fresh.isRegisteredNamespace(MidaHashing.namespaceId(names[i])), names[i]);
        }
    }

    function test_parentsAreProtocolState() public view {
        assertEq(tree.namespaceParent(MidaHashing.namespaceId("profile")), bytes32(0));
        assertEq(tree.namespaceParent(MidaHashing.namespaceId("projects.past")), MidaHashing.namespaceId("projects"));
        assertEq(
            tree.namespaceParent(MidaHashing.namespaceId("financial.preferences")), MidaHashing.namespaceId("financial")
        );
    }

    function test_highSensitivitySetIsExactlyFourNodes() public view {
        string[] memory names = _names();
        uint256 high;
        for (uint256 i = 0; i < names.length; i++) {
            if (tree.isHighSensitivity(MidaHashing.namespaceId(names[i]))) high++;
        }
        assertEq(high, 4);
        assertTrue(tree.isHighSensitivity(MidaHashing.namespaceId("credentials")));
        assertTrue(tree.isHighSensitivity(MidaHashing.namespaceId("financial")));
        assertTrue(tree.isHighSensitivity(MidaHashing.namespaceId("financial.preferences")));
        assertTrue(tree.isHighSensitivity(MidaHashing.namespaceId("private")));
        assertFalse(tree.isHighSensitivity(MidaHashing.namespaceId("relationships")));
    }

    function test_unknownNamespaceReverts() public {
        bytes32 invented = MidaHashing.namespaceId("goals.career.secret");
        assertFalse(tree.isRegisteredNamespace(invented));
        vm.expectRevert(abi.encodeWithSelector(InvalidNamespace.selector, invented));
        tree.namespaceParent(invented);
    }

    /// @dev §15 "deployed v1 tree receives a new child": no mutation entry point exists.
    function test_noNamespaceRegistrationFunctionExists() public {
        (bool ok,) = address(tree).call(abi.encodeWithSignature("registerNamespace(string,bytes32)", "goals.side", bytes32(0)));
        assertFalse(ok);
        (ok,) = address(tree).call(abi.encodeWithSignature("registerNamespace(bytes32,bytes32)", bytes32(uint256(1)), bytes32(0)));
        assertFalse(ok);
    }
}
