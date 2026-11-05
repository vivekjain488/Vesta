// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseTest} from "./Base.t.sol";
import {ComputeTreasury} from "../src/ComputeTreasury.sol";
import {PerpetuaVault} from "../src/PerpetuaVault.sol";
import {RiskGate} from "../src/RiskGate.sol";
import {AgentWallet} from "../src/AgentWallet.sol";
import {Client} from "../src/ccip/Client.sol";

/// Earn -> poke() harvest -> swap to 0G -> CCIP -> ComputeTreasury -> operator withdraws for the 0G ledger.
contract HarvestFlowTest is BaseTest {
    function setUp() public override {
        super.setUp();
        _deposit(alice, 1_000e6);
        vm.prank(owner);
        vault.setFeeParams(0, 0, 20e6); // compute bill this cycle: 20 USDC
    }

    function _earn(bytes32 engine, uint256 amount) internal {
        usdc.mint(address(this), amount);
        usdc.approve(address(vault), amount);
        vault.recordIncome(engine, amount);
    }

    function test_fullLoop_incomeToComputeLedger() public {
        _earn("signals", 30e6);
        _earn("copy_fees", 20e6);

        vm.prank(keeper);
        gate.poke(_noPrices());

        // 20 USDC harvested, swapped at 2 0G/USDC = 40 0G in flight over CCIP
        assertEq(vault.totalHarvested(), 20e6);
        assertEq(vault.unharvestedIncome(), 30e6, "income beyond the bill stays in NAV");
        assertEq(ccip.messageCount(), 1);
        assertEq(treasury.balanceOf(AGENT_ID), 0, "not credited until CCIP finalises");

        bytes32 msgId = ccip.messageIds(0);
        ccip.deliver(msgId);
        assertEq(treasury.balanceOf(AGENT_ID), 40e18);

        // agent runtime pulls to its own wallet for broker.ledger.depositFund()
        vm.prank(operator);
        treasury.withdrawForLedger(AGENT_ID, 40e18);
        assertEq(zeroG.balanceOf(operator), 40e18);

        // floor never touched
        (uint256 V, uint256 F,,) = _mandate();
        assertGe(V, F);
    }

    function test_harvestNeverExceedsCushion() public {
        vm.prank(owner);
        vault.setFeeParams(0, 0, 500e6); // absurd bill
        _earn("signals", 10e6);
        gate.poke(_noPrices());
        // capped by maxHarvestPerCycle (50) and harvestable income (10)
        assertEq(vault.totalHarvested(), 10e6);
        (uint256 V, uint256 F,,) = _mandate();
        assertGe(V, F);
    }

    function test_noIncome_noHarvest_floorFundsNothing() public {
        gate.poke(_noPrices());
        assertEq(vault.totalHarvested(), 0, "principal is never spent on compute");
    }

    function test_treasury_rejectsUnknownSenderAndReplays() public {
        Client.EVMTokenAmount[] memory toks = new Client.EVMTokenAmount[](0);
        Client.Any2EVMMessage memory m = Client.Any2EVMMessage({
            messageId: keccak256("m"),
            sourceChainSelector: LOCAL_SELECTOR,
            sender: abi.encode(alice),
            data: abi.encode(AGENT_ID, 1e18, uint64(1)),
            destTokenAmounts: toks
        });
        vm.prank(address(ccip));
        vm.expectRevert(abi.encodeWithSelector(ComputeTreasury.UnknownSender.selector, LOCAL_SELECTOR, alice));
        treasury.ccipReceive(m);

        // only the router can call ccipReceive at all
        vm.expectRevert();
        treasury.ccipReceive(m);
    }

    function test_treasury_creditsWhatArrived_notWhatIsClaimed() public {
        _earn("signals", 30e6);
        gate.poke(_noPrices());
        ccip.deliver(ccip.messageIds(0));
        assertEq(treasury.balanceOf(AGENT_ID), 40e18);
    }

    function test_treasury_dailySpendCap() public {
        vm.prank(owner);
        treasury.configureAgent(AGENT_ID, operator, 10e18);
        _earn("signals", 30e6);
        gate.poke(_noPrices());
        ccip.deliver(ccip.messageIds(0));
        vm.startPrank(operator);
        treasury.withdrawForLedger(AGENT_ID, 10e18);
        vm.expectRevert(abi.encodeWithSelector(ComputeTreasury.OverDailyCap.selector, 1e18, 0));
        treasury.withdrawForLedger(AGENT_ID, 1e18);
        vm.warp(block.timestamp + 1 days);
        treasury.withdrawForLedger(AGENT_ID, 10e18);
        vm.stopPrank();
    }

    /// Pillar 2: a follower vault's fees pay the compute bill first; only the excess becomes owner profit.
    function test_followerVault_billsFirstThenOwnerProfit() public {
        vm.startPrank(owner);
        PerpetuaVault fv =
            new PerpetuaVault(usdc, "Atlas Followers", "fATLAS", AGENT_ID, 9_500, 0, true, owner);
        AgentWallet fw = new AgentWallet(owner);
        RiskGate fg = new RiskGate(address(fv), address(fw), 250e6, 1, proposer, priceSigner, owner);
        fw.wire(address(fv), address(fg), proposer, flashSpender);
        fv.wire(address(lending), address(fg), address(fw), address(router));
        router.setVault(address(fv), true);
        fg.setKeeperEconomics(0, 50e6, 1e6, 4 hours);
        fv.setFeeParams(300, 1_000, 2e6); // 3%/yr mgmt (cap), 10% perf; compute bill 2 USDC
        vm.stopPrank();

        usdc.mint(alice, 10_000e6);
        vm.startPrank(alice);
        usdc.approve(address(fv), 10_000e6);
        fv.deposit(10_000e6, alice);
        vm.stopPrank();

        fg.poke(_noPrices());
        vm.warp(block.timestamp + 30 days);
        fg.poke(_noPrices()); // accrues ~24.6 USDC mgmt fee (+ perf on yield), harvests 2 for compute
        assertEq(fv.totalHarvested(), 2e6, "compute bill paid first");
        assertGt(fv.ownerClaimable(), 20e6, "excess fee is owner profit");
        // follower floor intact
        (,,, uint256 V, uint256 F,,,,) = fg.mandate();
        assertGe(V, F);
    }
}
