// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Script} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {PerpetuaVault} from "../src/PerpetuaVault.sol";
import {AgentWallet} from "../src/AgentWallet.sol";
import {RiskGate} from "../src/RiskGate.sol";
import {HarvestRouter} from "../src/HarvestRouter.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";
import {MockLending} from "../src/mocks/MockLending.sol";

/// @notice Sepolia-only demo. No live trade authorization, yield, seed deposits, or bridge route.
contract DeploySepoliaDemo is Script {
    function run() external {
        require(block.chainid == 11155111, "Ethereum Sepolia only");
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address owner = vm.addr(pk);
        address token = vm.envAddress("SEPOLIA_DEMO_USDC");
        address routerAddress = vm.envAddress("SEPOLIA_CCIP_ROUTER");
        address link = vm.envAddress("SEPOLIA_LINK_ADDRESS");
        require(token.code.length > 0 && routerAddress.code.length > 0 && link.code.length > 0, "missing dependencies");
        require(IERC20Metadata(token).decimals() == 6, "USDC decimals must be 6");
        vm.startBroadcast(pk);
        MockLending safe = new MockLending(token, 0, owner);
        HarvestRouter router = new HarvestRouter(routerAddress, token, owner);
        AgentRegistry registry = new AgentRegistry(0, owner);
        string[3] memory names = [string("Atlas"), "Halcyon", "Ember"];
        string memory output = "sepolia";
        for (uint256 i; i < names.length; ++i) {
            bytes32 id = keccak256(bytes(names[i]));
            PerpetuaVault vault = new PerpetuaVault(IERC20(token), string.concat("Vesta demo ", names[i]), string.concat("vd", names[i]), id, 9500, 10e6, false, owner);
            AgentWallet wallet = new AgentWallet(owner);
            RiskGate gate = new RiskGate(address(vault), address(wallet), 250e6, 1, owner, owner, owner);
            wallet.wire(address(vault), address(gate), owner, address(0));
            vault.wire(address(safe), address(gate), address(wallet), address(router));
            // The router is deliberately not configured or allowed to receive harvested funds.
            registry.register(id, names[i], "Sepolia demo; trading and bridge disabled", address(vault), address(gate), address(wallet), owner);
            vm.serializeAddress(names[i], "vault", address(vault));
            vm.serializeAddress(names[i], "wallet", address(wallet));
            vm.serializeAddress(names[i], "riskGate", address(gate));
            vm.serializeAddress(names[i], "safeLeg", address(safe));
            vm.serializeBytes32(names[i], "agentId", id);
            string memory agent = vm.serializeBool(names[i], "platformAgent", true);
            output = vm.serializeString("sepolia", names[i], agent);
        }
        vm.serializeAddress("sepolia", "owner", owner);
        vm.serializeAddress("sepolia", "usdc", token);
        vm.serializeAddress("sepolia", "link", link);
        vm.serializeAddress("sepolia", "ccipRouter", routerAddress);
        vm.serializeBool("sepolia", "executionEnabled", false);
        vm.serializeAddress("sepolia", "safeLeg", address(safe));
        vm.serializeAddress("sepolia", "harvestRouter", address(router));
        vm.serializeUint("sepolia", "startBlock", block.number);
        output = vm.serializeAddress("sepolia", "registry", address(registry));
        vm.stopBroadcast();
        vm.writeJson(output, "./deployments/sepolia-demo-11155111.json");
    }
}
