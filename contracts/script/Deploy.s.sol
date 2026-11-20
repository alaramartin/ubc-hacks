// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {ReceiptEscrow, IUSDC, IHalo2Verifier} from "../src/ReceiptEscrow.sol";
import {Halo2Verifier} from "../src/Halo2Verifier.sol";

/// Deploys the shared Halo2 verifier for the risk model architecture and the escrow.
/// Env: DEPLOYER_KEY, USDC_ADDRESS, N_INPUTS, N_OUTPUTS, MIN_BOND, SLASH_AMOUNT, CHALLENGE_WINDOW, VERIFY_GAS
contract Deploy is Script {
    function run() external {
        uint256 key = vm.envUint("DEPLOYER_KEY");
        vm.startBroadcast(key);
        Halo2Verifier verifier = new Halo2Verifier();
        ReceiptEscrow escrow = new ReceiptEscrow(
            IUSDC(vm.envAddress("USDC_ADDRESS")),
            IHalo2Verifier(address(verifier)),
            vm.envUint("N_INPUTS"),
            vm.envUint("N_OUTPUTS"),
            vm.envUint("MIN_BOND"),
            vm.envUint("SLASH_AMOUNT"),
            uint64(vm.envUint("CHALLENGE_WINDOW")),
            vm.envUint("VERIFY_GAS")
        );
        vm.stopBroadcast();
        console.log("verifier", address(verifier));
        console.log("escrow", address(escrow));
    }
}
