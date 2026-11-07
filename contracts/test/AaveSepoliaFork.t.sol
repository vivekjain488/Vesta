// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AaveV3Adapter} from "../src/adapters/AaveV3Adapter.sol";

/// Explicit opt-in fork: Aave's Sepolia USDC differs from Circle's Sepolia USDC.
contract AaveSepoliaForkTest is Test {
    address constant POOL = 0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951;
    address constant USDC = 0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8;
    address constant A_USDC = 0x16dA4541aD1807f4443d92D26044C1147406EB80;
    function testForkSeparateVaultsSupplyAndWithdraw() public {
        string memory rpc = vm.envOr("SEPOLIA_FORK_RPC_URL", string(""));
        if (bytes(rpc).length == 0) vm.skip(true);
        vm.createSelectFork(rpc); assertEq(block.chainid, 11155111);
        address a = address(0xA11CE); address b = address(0xB0B);
        AaveV3Adapter x = new AaveV3Adapter(POOL, USDC, A_USDC, a);
        AaveV3Adapter y = new AaveV3Adapter(POOL, USDC, A_USDC, b);
        deal(USDC, a, 100e6); deal(USDC, b, 200e6);
        vm.startPrank(a); IERC20(USDC).approve(address(x), 100e6); x.deposit(100e6); vm.stopPrank();
        vm.startPrank(b); IERC20(USDC).approve(address(y), 200e6); y.deposit(200e6); vm.stopPrank();
        assertApproxEqAbs(x.totalValue(a), 100e6, 2); assertApproxEqAbs(y.totalValue(b), 200e6, 2);
        vm.prank(a); assertApproxEqAbs(x.withdraw(100e6), 100e6, 2);
        vm.prank(b); assertApproxEqAbs(y.withdraw(200e6), 200e6, 2);
        assertApproxEqAbs(IERC20(USDC).balanceOf(a), 100e6, 2);
        assertApproxEqAbs(IERC20(USDC).balanceOf(b), 200e6, 2);
    }
}
