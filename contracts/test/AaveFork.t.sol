// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AaveV3Adapter} from "../src/adapters/AaveV3Adapter.sol";

/// Fork test against real Aave v3 on Base. Skipped unless BASE_RPC_URL is set:
///   BASE_RPC_URL=https://mainnet.base.org forge test --match-contract AaveForkTest -vv
contract AaveForkTest is Test {
    address constant POOL = 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5; // Aave v3 Pool (Base)
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913; // native USDC (Base)
    address constant A_USDC = 0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB; // aBasUSDC

    AaveV3Adapter adapter;
    bool live;

    function setUp() public {
        string memory rpc = vm.envOr("BASE_RPC_URL", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        live = true;
        adapter = new AaveV3Adapter(POOL, USDC, A_USDC, address(this));
        deal(USDC, address(this), 1_000e6);
        IERC20(USDC).approve(address(adapter), type(uint256).max);
    }

    function test_fork_supplyAccrueWithdraw() public {
        if (!live) return;
        adapter.deposit(1_000e6);
        assertApproxEqAbs(adapter.totalValue(address(this)), 1_000e6, 2);
        vm.warp(block.timestamp + 30 days);
        vm.roll(block.number + 1);
        uint256 v = adapter.totalValue(address(this));
        assertGt(v, 1_000e6, "aToken rebased with interest");
        uint256 out = adapter.withdraw(v);
        assertApproxEqAbs(out, v, 2);
        assertGt(IERC20(USDC).balanceOf(address(this)), 1_000e6);
    }
}
