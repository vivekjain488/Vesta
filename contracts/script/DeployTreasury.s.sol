// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {ComputeTreasury} from "../src/ComputeTreasury.sol";

/// @notice Deploys ComputeTreasury on 0G Galileo (or 0G mainnet) and allow-lists the vault-chain
///         HarvestRouter as a CCIP sender.
///   forge script script/DeployTreasury.s.sol --rpc-url og_galileo --broadcast
/// Env: DEPLOYER_PRIVATE_KEY, OG_CCIP_ROUTER (CCIP router on 0G), OG_CCT_TOKEN (the $0G CCT as released by the
///      pool on 0G, e.g. wrapped native), SOURCE_CHAIN_SELECTOR, HARVEST_ROUTER, AGENT_OPERATOR, AGENT_IDS
///      (comma-separated names), DAILY_CAP_OG (wei), UNWRAP_TO_NATIVE.
contract DeployTreasury is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);
        vm.startBroadcast(pk);
        ComputeTreasury t = new ComputeTreasury(vm.envAddress("OG_CCIP_ROUTER"), vm.envAddress("OG_CCT_TOKEN"), deployer);
        t.setAllowedSender(uint64(vm.envUint("SOURCE_CHAIN_SELECTOR")), vm.envAddress("HARVEST_ROUTER"), true);
        t.setUnwrap(vm.envOr("UNWRAP_TO_NATIVE", false));
        string[] memory names = vm.envString("AGENT_IDS", ",");
        for (uint256 i; i < names.length; ++i) {
            t.configureAgent(keccak256(bytes(names[i])), vm.envAddress("AGENT_OPERATOR"), vm.envUint("DAILY_CAP_OG"));
        }
        vm.stopBroadcast();
        console2.log("ComputeTreasury", address(t));
    }
}
