// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {Halo2Verifier} from "../src/Halo2Verifier.sol";

contract SpikeVerifierTest is Test {
    Halo2Verifier v;
    bytes proof;
    uint256[] instances;

    function setUp() public {
        v = new Halo2Verifier();
        string memory j = vm.readFile("test/fixtures/spike.json");
        proof = vm.parseJsonBytes(j, ".proof");
        string[] memory s = vm.parseJsonStringArray(j, ".instances");
        for (uint256 i = 0; i < s.length; i++) instances.push(vm.parseUint(s[i]));
    }

    function test_verifies() public {
        uint256 g = gasleft();
        bool ok = v.verifyProof(proof, instances);
        console.log("verify gas", g - gasleft());
        assertTrue(ok);
    }

    function test_tamperedOutputFails() public {
        instances[instances.length - 1] += 1;
        (bool success, bytes memory ret) = address(v).call(abi.encodeCall(v.verifyProof, (proof, instances)));
        assertTrue(!success || !abi.decode(ret, (bool)));
    }

    function test_tamperedCommitmentFails() public {
        instances[0] += 1;
        (bool success, bytes memory ret) = address(v).call(abi.encodeCall(v.verifyProof, (proof, instances)));
        assertTrue(!success || !abi.decode(ret, (bool)));
    }
}
