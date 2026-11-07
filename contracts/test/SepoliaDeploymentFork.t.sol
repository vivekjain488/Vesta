// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PerpetuaVault} from "../src/PerpetuaVault.sol";
import {MockLending} from "../src/mocks/MockLending.sol";

/// @dev Optional read-only fork rehearsal; `deal` only changes the local fork, never Sepolia.
contract SepoliaDeploymentForkTest is Test {
    address constant USDC = 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238;
    MockLending constant LENDING = MockLending(0x6334fA28Fee591C234721f2900136FD36C83d55C);

    function test_deployedVaultDepositAndRedeemOnFork() public {
        string memory rpc = vm.envOr("SEPOLIA_FORK_RPC_URL", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        _roundTrip(PerpetuaVault(0x4AD9a90148e002E8330C0010727124467A211288));
        _roundTrip(PerpetuaVault(0x71a3c2Be9Db671847197AcfCB95849B2074e4035));
        _roundTrip(PerpetuaVault(0x1e988204163697F55F6556489eE0d83bb6e0D0F1));
    }

    function _roundTrip(PerpetuaVault vault) private {
        address depositor = makeAddr("sepolia-depositor");
        uint256 amount = 100e6;
        deal(USDC, depositor, amount);
        uint256 originalAssets = vault.totalAssets();
        uint256 originalLending = LENDING.totalValue(address(vault));
        vm.startPrank(depositor);
        IERC20(USDC).approve(address(vault), amount);
        uint256 shares = vault.deposit(amount, depositor);
        assertEq(vault.totalAssets(), originalAssets + amount);
        assertGt(LENDING.totalValue(address(vault)), originalLending);
        uint256 returned = vault.redeem(shares, depositor, depositor);
        vm.stopPrank();
        assertEq(returned, amount);
        assertEq(IERC20(USDC).balanceOf(depositor), amount);
        assertEq(vault.balanceOf(depositor), 0);
        assertEq(vault.totalAssets(), originalAssets);
    }

}
