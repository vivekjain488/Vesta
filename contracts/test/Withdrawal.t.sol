// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseTest} from "./Base.t.sol";
import {RiskGate} from "../src/RiskGate.sol";
import {AgentWallet} from "../src/AgentWallet.sol";

contract WithdrawalTest is BaseTest {
    function test_ownerCanWithdrawWithFlashSpenderDisabled() public {
        vm.prank(owner);
        wallet.setFlashSpender(address(0));
        uint256 shares = vault.balanceOf(alice);
        vm.prank(alice);
        vault.redeem(shares, alice, alice);
        assertEq(vault.balanceOf(alice), 0);
        assertTrue(gate.withdrawalPaused());
        vm.prank(address(gate));
        vm.expectRevert(AgentWallet.FlashSpenderNotConfigured.selector);
        wallet.grantFlashAllowance(address(usdc), 1, 1);
    }
    function setUp() public override {
        super.setUp();
        vm.prank(owner);
        vault.setAgentOwner(alice);
        _deposit(alice, 1_000e6);
    }

    function test_withdrawProtectedAllocationUsesSafeLeg() public {
        uint256 cashBefore = vault.idle();
        uint256 safeBefore = vault.safeValue();
        vm.prank(alice);
        vault.withdrawFromInvestment(20e6, alice, true);
        assertEq(vault.idle(), cashBefore);
        assertEq(vault.safeValue(), safeBefore - 20e6);
        assertEq(usdc.balanceOf(alice), 20e6);
    }

    function test_cashWithdrawalDoesNotTouchProtectedAllocation() public {
        uint256 safeBefore = vault.safeValue();
        vm.prank(alice);
        vault.withdrawFromInvestment(20e6, alice, false);
        assertEq(vault.safeValue(), safeBefore);
        assertEq(vault.idle(), 10e6);
        vm.prank(alice);
        vm.expectRevert();
        vault.withdrawFromInvestment(20e6, alice, false);
        assertEq(vault.safeValue(), safeBefore);
    }

    function test_partialWithdrawalAboveMinimumKeepsAgentAwakeAndInvalidatesOldEntries() public {
        gate.poke(_noPrices());
        bytes32 digest = keccak256("old-entry");
        RiskGate.OrderIntent memory entry = _entry(digest, 20e6, LINK_PRICE * 92 / 100);
        RiskGate.PriceAttestation memory px = _price(address(link), LINK_PRICE);
        RiskGate.TeeProof memory proof = _tee("long");
        vm.prank(proposer);
        gate.approveOrder(entry, px, proof);
        assertTrue(gate.isApproved(digest));
        vm.prank(alice);
        vault.withdraw(100e6, alice, alice);
        assertFalse(gate.withdrawalPaused());
        assertFalse(gate.hibernating());
        assertFalse(gate.isApproved(digest));
        assertEq(usdc.allowance(address(wallet), flashSpender), 0);
        gate.poke(_noPrices());
        (,,, uint256 E) = _mandate();
        assertGt(E, 0);
    }

    function test_withdrawBelowMinimumSleepsAndDoesNotAutoWake() public {
        vm.prank(alice);
        vault.withdraw(976e6, alice, alice);
        assertTrue(gate.withdrawalPaused());
        assertTrue(gate.hibernating());
        usdc.mint(address(this), 100e6);
        usdc.approve(address(vault), 100e6);
        vault.recordIncome("signals", 100e6);
        vm.warp(block.timestamp + 5 hours);
        gate.poke(_noPrices());
        (,,, uint256 E) = _mandate();
        assertEq(E, 0);
        assertTrue(gate.withdrawalPaused());
        assertEq(vault.totalHarvested(), 0);
    }

    function test_exactMinimumStaysAwake() public {
        vm.prank(alice);
        vault.withdraw(975e6, alice, alice);
        assertFalse(gate.withdrawalPaused());
    }

    function test_fullRedemptionSleeps() public {
        uint256 shares = vault.balanceOf(alice);
        vm.prank(alice);
        vault.redeem(shares, alice, alice);
        assertEq(vault.balanceOf(alice), 0);
        assertEq(usdc.balanceOf(alice), 1_000e6);
        assertTrue(gate.withdrawalPaused());
    }

    function test_lossDoesNotBlockWithdrawal() public {
        gate.poke(_noPrices());
        usdc.burn(address(wallet), 30e6); // realised investment loss; withdrawing is still allowed
        uint256 shares = vault.balanceOf(alice);
        vm.prank(alice);
        uint256 received = vault.redeem(shares, alice, alice);
        assertLt(received, 1_000e6);
        assertGt(received, 950e6);
        assertTrue(gate.withdrawalPaused());
    }

    function test_sleepCanBeRequestedWhileRiskyFundsAreIlliquidAndExitsSurvive() public {
        gate.poke(_noPrices());
        bytes32 digest = keccak256("bracket-entry");
        RiskGate.OrderIntent memory entry = _entry(digest, 60e6, LINK_PRICE * 92 / 100);
        entry.bracketDigest = keccak256("protective-exit");
        RiskGate.PriceAttestation memory px = _price(address(link), LINK_PRICE);
        RiskGate.TeeProof memory proof = _tee("long");
        vm.prank(proposer);
        gate.approveOrder(entry, px, proof);
        usdc.burn(address(wallet), 60e6);
        link.mint(address(wallet), 4e18);
        gate.poke(_prices(address(link), LINK_PRICE));
        assertApproxEqAbs(vault.totalAssets(), 1_000e6 - 0.05e6, 1, "same-value swap must update risky holdings mark");
        vm.prank(alice);
        gate.requestWithdrawalSleep();
        assertTrue(gate.withdrawalPaused());
        assertFalse(gate.isApproved(digest));
        assertTrue(gate.isApproved(entry.bracketDigest));
        assertLt(vault.maxWithdraw(alice), vault.convertToAssets(vault.balanceOf(alice)));
        assertGt(vault.balanceOf(alice), 0, "illiquid shares remain redeemable after settlement");
    }

    function test_ownerOnlySleepResumeAndThreshold() public {
        vm.expectRevert("agent owner only");
        gate.requestWithdrawalSleep();
        vm.expectRevert("vault only");
        gate.onOwnerWithdrawal();
        vm.expectRevert("agent owner only");
        gate.setMinimumOperatingCapital(100e6);
        vm.prank(alice);
        gate.setMinimumOperatingCapital(100e6);
        assertEq(gate.minimumOperatingCapital(), 100e6);
    }

    function test_zeroAndOtherDepositorWithdrawalsCannotSleepOwnerAgent() public {
        vault.withdraw(0, address(this), alice);
        assertFalse(gate.withdrawalPaused());
        address bob = makeAddr("bob");
        _deposit(bob, 10e6);
        uint256 bobShares = vault.balanceOf(bob);
        vm.prank(bob);
        vault.redeem(bobShares, bob, bob);
        assertFalse(gate.withdrawalPaused());
    }

    function test_resumeRequiresCapitalAndFreshMandate() public {
        vm.prank(alice);
        vault.withdraw(999e6, alice, alice);
        vm.prank(alice);
        vm.expectRevert("capital below minimum");
        gate.resumeAfterWithdrawal();
        _deposit(alice, 1_000e6);
        assertTrue(gate.withdrawalPaused(), "deposit does not silently resume");
        vm.prank(alice);
        gate.resumeAfterWithdrawal();
        assertTrue(gate.hibernating(), "must refresh prices and mandate first");
        gate.poke(_noPrices());
        assertFalse(gate.hibernating());
    }

    function test_sleepDoesNotAccrueManagementFeesOrHarvestCompute() public {
        vm.prank(owner);
        vault.setFeeParams(100, 0, 10e6);
        vm.prank(alice);
        gate.requestWithdrawalSleep();
        vm.warp(block.timestamp + 365 days);
        gate.poke(_noPrices());
        assertEq(vault.feeAccrued(), 0);
        assertEq(vault.totalHarvested(), 0);
        vm.prank(alice);
        gate.resumeAfterWithdrawal();
        gate.poke(_noPrices());
        assertEq(vault.feeAccrued(), 0, "sleeping year must not be charged on resume");
    }
}
