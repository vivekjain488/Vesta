// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseTest} from "./Base.t.sol";
import {PerpetuaVault} from "../src/PerpetuaVault.sol";

contract PerpetuaVaultTest is BaseTest {
    function test_depositRecordsPrincipalAndDeploysToSafeLeg() public {
        _deposit(alice, 1_000e6);
        assertEq(vault.principal(), 1_000e6);
        assertEq(vault.floorValue(), 960e6);
        assertEq(vault.totalAssets(), 1_000e6);
        assertEq(lending.totalValue(address(vault)), 970e6, "97% lent, 3% idle buffer");
    }

    function test_incomeRaisesCushionNotPrincipal() public {
        _deposit(alice, 1_000e6);
        usdc.mint(address(this), 43e6);
        usdc.approve(address(vault), 43e6);
        vault.recordIncome("signals", 43e6);
        assertEq(vault.principal(), 1_000e6);
        assertEq(vault.totalAssets(), 1_043e6);
        assertEq(vault.incomeByEngine("signals"), 43e6);
        gate.poke(_noPrices());
        (,, uint256 C, uint256 E) = _mandate();
        assertEq(C, 83e6);
        assertEq(E, 249e6);
    }

    function test_safeLegYieldAccrues() public {
        _deposit(alice, 1_000e6);
        vm.warp(block.timestamp + 365 days);
        // 4.5% on the 970 lent
        assertApproxEqAbs(lending.totalValue(address(vault)), 970e6 + 43.65e6, 1e4);
        assertApproxEqAbs(vault.safeYield(), 43.65e6, 1e4);
    }

    /// Principal protection: even if the trading wallet takes a loss right up to the cushion (a stop-out inside
    /// the 1/m gap tolerance), a full withdrawal returns at least pi * P.
    function test_principalProtected_afterMaxStopLoss() public {
        _deposit(alice, 1_000e6);
        gate.poke(_noPrices()); // wallet funded with E = 120
        usdc.burn(address(wallet), 39e6); // worst stop-out <= C
        vm.warp(block.timestamp + 5 hours);
        gate.poke(_noPrices()); // re-mark: wallet pulled back (E -> 0 via breakers)
        uint256 shares = vault.balanceOf(alice);
        vm.prank(alice);
        uint256 out = vault.redeem(shares, alice, alice);
        assertGe(out, 950e6, "depositor gets >= pi * P");
    }

    function test_withdrawAnytime_pullsFromWalletIfNeeded() public {
        _deposit(alice, 1_000e6);
        gate.poke(_noPrices());
        uint256 max = vault.maxWithdraw(alice);
        assertApproxEqAbs(max, 1_000e6 - 0.05e6, 1);
        vm.prank(alice);
        vault.withdraw(max, alice, alice);
        assertEq(usdc.balanceOf(alice), max);
        assertApproxEqAbs(vault.principal(), 0, 0.1e6);
    }

    function test_onlyRiskGateMovesMoney() public {
        _deposit(alice, 1_000e6);
        vm.expectRevert(PerpetuaVault.OnlyRiskGate.selector);
        vault.fundWallet(1e6);
        vm.expectRevert(PerpetuaVault.OnlyRiskGate.selector);
        vault.harvest(1e6, 1);
        vm.expectRevert(PerpetuaVault.OnlyRiskGate.selector);
        vault.payBounty(alice, 1e6);
    }

    function test_cannotRewire() public {
        vm.prank(owner);
        vm.expectRevert(PerpetuaVault.AlreadyWired.selector);
        vault.wire(address(lending), alice, alice, alice);
    }

    function test_feeCaps() public {
        vm.prank(owner);
        vm.expectRevert(PerpetuaVault.FeeTooHigh.selector);
        vault.setFeeParams(301, 1_000, 0);
    }

    function test_realisedProfitCountsAsIncome() public {
        _deposit(alice, 1_000e6);
        gate.poke(_noPrices()); // funded 120
        usdc.mint(address(wallet), 15e6); // a winning trade closed back to USDC
        vm.prank(owner);
        vault.emergencyPullFromWallet(135e6);
        assertEq(vault.unharvestedIncome(), 15e6);
        assertEq(vault.incomeByEngine("trading"), 15e6);
    }
}
