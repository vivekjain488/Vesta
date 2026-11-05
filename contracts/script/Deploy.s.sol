// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {PerpetuaVault} from "../src/PerpetuaVault.sol";
import {RiskGate} from "../src/RiskGate.sol";
import {AgentWallet} from "../src/AgentWallet.sol";
import {HarvestRouter} from "../src/HarvestRouter.sol";
import {ComputeTreasury} from "../src/ComputeTreasury.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {MockLending} from "../src/mocks/MockLending.sol";
import {MockCCIPRouter} from "../src/mocks/MockCCIPRouter.sol";
import {MockSwapAdapter} from "../src/mocks/MockSwapAdapter.sol";

/// @notice Deploys the full Perpetua stack.
///   MODE=local  -> everything on one chain (anvil) incl. mock USDC/LINK/0G, MockLending and a local CCIP
///                  simulator. Used by the offline demo and `pnpm demo`.
///   MODE=vault  -> vault-chain stack against real CCIP router + USDC (env addresses); treasury deployed
///                  separately on 0G Galileo with DeployTreasury.s.sol.
/// Three Arena agents are deployed (momentum / mean-reversion / DCA), one per risk tier.
contract Deploy is Script {
    struct AgentSpec {
        string name;
        string strategy;
        uint8 tier;
        uint256 piBps;
        uint256 eMax;
    }

    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address proposer = vm.envOr("PROPOSER_ADDRESS", deployer);
        address priceSigner = vm.envOr("PRICE_SIGNER_ADDRESS", deployer);
        address teeSigner = vm.envOr("TEE_SIGNER_ADDRESS", deployer);
        address flashSpender = vm.envOr("FLASH_SPENDER_ADDRESS", deployer);
        string memory mode = vm.envOr("MODE", string("local"));
        bool local = keccak256(bytes(mode)) == keccak256("local");

        vm.startBroadcast(pk);

        address usdc;
        address link;
        address zeroG;
        address ccipRouter;
        address safeLeg;
        address swap;
        uint64 localSelector = uint64(vm.envOr("LOCAL_CHAIN_SELECTOR", uint256(16015286601757825753)));
        uint64 ogSelector = uint64(vm.envOr("OG_CHAIN_SELECTOR", uint256(2131427466778448014)));

        if (local) {
            usdc = address(new MockERC20("USD Coin", "USDC", 6));
            link = address(new MockERC20("Chainlink", "LINK", 18));
            zeroG = address(new MockERC20("0G", "0G", 18));
            ccipRouter = address(new MockCCIPRouter(localSelector));
            MockCCIPRouter(ccipRouter).setAutoDeliver(vm.envOr("CCIP_AUTO_DELIVER", false));
            MockLending ml = new MockLending(usdc, 450, deployer);
            ml.setRate(450, vm.envOr("LENDING_TIME_MULTIPLIER", uint256(1)));
            safeLeg = address(ml);
            MockSwapAdapter ms = new MockSwapAdapter(deployer);
            ms.setRate(usdc, zeroG, 2e30); // 1 USDC = 2 0G (testnet assumption, replace with live price)
            swap = address(ms);
            // one-time disclosed seeds
            MockERC20(zeroG).mint(swap, 10_000_000e18);
            MockERC20(usdc).mint(deployer, 100_000e6);
            IERC20(usdc).approve(safeLeg, type(uint256).max);
            ml.fundReserve(5_000e6);
        } else {
            usdc = vm.envAddress("USDC_ADDRESS");
            link = vm.envAddress("LINK_ADDRESS");
            zeroG = vm.envAddress("ZEROG_CCT_ADDRESS");
            ccipRouter = vm.envAddress("CCIP_ROUTER_ADDRESS");
            safeLeg = vm.envAddress("SAFE_LEG_ADDRESS");
            swap = vm.envAddress("SWAP_ADAPTER_ADDRESS");
        }

        HarvestRouter router = new HarvestRouter(ccipRouter, usdc, deployer);
        ComputeTreasury treasury;
        if (local) {
            treasury = new ComputeTreasury(ccipRouter, zeroG, deployer);
            treasury.setAllowedSender(localSelector, address(router), true);
        }
        address treasuryAddr = local ? address(treasury) : vm.envAddress("COMPUTE_TREASURY_ADDRESS");
        router.configure(zeroG, swap, ogSelector, treasuryAddr, 100, 300_000);
        AgentRegistry registry = new AgentRegistry(0, deployer);

        AgentSpec[3] memory specs = [
            AgentSpec("Atlas", "Momentum: 4h trend + breakout, bracket exits", 1, 9_500, 250e6),
            AgentSpec("Halcyon", "Mean-reversion in range regimes, limit entries", 0, 9_800, 150e6),
            AgentSpec("Ember", "DCA accumulator, aggressive cushion use", 2, 9_000, 400e6)
        ];

        string memory json = "deploy";
        for (uint256 i; i < specs.length; ++i) {
            bytes32 agentId = keccak256(bytes(specs[i].name));
            PerpetuaVault vault = new PerpetuaVault(
                IERC20(usdc),
                string.concat("Perpetua ", specs[i].name),
                string.concat("p", specs[i].name),
                agentId,
                specs[i].piBps,
                10e6,
                false,
                deployer
            );
            AgentWallet wallet = new AgentWallet(deployer);
            RiskGate gate =
                new RiskGate(address(vault), address(wallet), specs[i].eMax, specs[i].tier, proposer, priceSigner, deployer);
            wallet.wire(address(vault), address(gate), proposer, flashSpender);
            address legForVault = safeLeg;
            vault.wire(legForVault, address(gate), address(wallet), address(router));
            gate.setAsset(link, true, 500);
            gate.setTeeSigner(teeSigner, true);
            gate.setKeeperEconomics(0.05e6, 50e6, 1e6, uint64(vm.envOr("POKE_INTERVAL", uint256(4 hours))));
            vault.setFeeManager(proposer);
            router.setVault(address(vault), true);
            registry.register(agentId, specs[i].name, specs[i].strategy, address(vault), address(gate), address(wallet), proposer);
            if (local) {
                treasury.configureAgent(agentId, proposer, 1_000e18);
                // disclosed one-time seed deposit (README: the only human-funded transfer)
                IERC20(usdc).approve(address(vault), 1_000e6);
                vault.deposit(1_000e6, deployer);
            }

            string memory k = specs[i].name;
            vm.serializeAddress(k, "vault", address(vault));
            vm.serializeAddress(k, "wallet", address(wallet));
            vm.serializeBytes32(k, "agentId", agentId);
            string memory agentJson = vm.serializeAddress(k, "riskGate", address(gate));
            json = vm.serializeString("deploy", specs[i].name, agentJson);
        }
        vm.serializeAddress("deploy", "usdc", usdc);
        vm.serializeAddress("deploy", "link", link);
        vm.serializeAddress("deploy", "zeroG", zeroG);
        vm.serializeAddress("deploy", "ccipRouter", ccipRouter);
        vm.serializeAddress("deploy", "safeLeg", safeLeg);
        vm.serializeAddress("deploy", "harvestRouter", address(router));
        vm.serializeAddress("deploy", "registry", address(registry));
        json = vm.serializeAddress("deploy", "computeTreasury", treasuryAddr);
        vm.stopBroadcast();

        vm.writeJson(json, string.concat("./deployments/", mode, "-", vm.toString(block.chainid), ".json"));
        console2.log("deployed; see deployments/", mode);
    }
}
