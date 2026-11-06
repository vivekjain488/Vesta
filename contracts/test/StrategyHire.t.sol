// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseTest} from "./Base.t.sol";
import {StrategyHire} from "../src/StrategyHire.sol";
import {HireReceiver} from "../src/HireReceiver.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";

contract StrategyHireTest is BaseTest {
    StrategyHire internal hireC;
    HireReceiver internal recv;
    bytes32 internal constant AGENT = keccak256("top-agent");
    address internal agentWallet = makeAddr("agentPrivyWallet");
    address internal leaderboardOperator = makeAddr("leaderboardOperator");
    MockERC20 internal weth;

    function setUp() public override {
        super.setUp();
        weth = new MockERC20("Wrapped Ether", "WETH", 18);
        vm.startPrank(owner);
        hireC = new StrategyHire(address(ccip), address(usdc), owner);
        recv = new HireReceiver(address(ccip), address(zeroG), owner);
        hireC.configure(address(zeroG), address(swap), OG_SELECTOR, address(recv), 250_000, 200);
        hireC.setOperator(leaderboardOperator);
        hireC.setAcceptedToken(address(link), true);
        recv.setAllowedSender(LOCAL_SELECTOR, address(hireC), true);
        recv.setPayout(AGENT, agentWallet);
        // swap venue: 1 LINK = $15 = 30 0G; 1 USDC = 2 0G (from BaseTest)
        swap.setRate(address(link), address(usdc), 15e6);
        swap.setRate(address(link), address(zeroG), 30e18);
        vm.stopPrank();
        ccip.setAutoDeliver(true);
        vm.prank(leaderboardOperator);
        hireC.setPlan(AGENT, 10e6, 30, true); // $10 for 30 days
        vm.deal(alice, 1 ether);
    }

    function _pay(address token, uint256 amount) internal returns (bytes32) {
        MockERC20(token).mint(alice, amount);
        vm.startPrank(alice);
        MockERC20(token).approve(address(hireC), amount);
        bytes32 id = hireC.hire{value: 0.01 ether}(AGENT, token, amount, 0);
        vm.stopPrank();
        return id;
    }

    function test_hireWithUsdc_paysAgentIn0G_overCcip() public {
        uint256 ethBefore = alice.balance;
        _pay(address(usdc), 10e6);
        assertEq(zeroG.balanceOf(agentWallet), 20e18, "agent wallet receives 0G");
        assertEq(recv.paidTotal(AGENT), 20e18);
        assertTrue(hireC.isHired(AGENT, alice));
        assertEq(hireC.hiredUntil(AGENT, alice), block.timestamp + 30 days);
        assertEq(ethBefore - alice.balance, ccip.flatFee(), "only the CCIP fee is kept; the rest is refunded");
    }

    function test_hireWithAnotherToken_isSwappedTo0G() public {
        _pay(address(link), 1e18); // $15 of LINK
        assertEq(zeroG.balanceOf(agentWallet), 30e18);
        assertTrue(hireC.isHired(AGENT, alice));
    }

    function test_repeatHireExtendsAccess() public {
        _pay(address(usdc), 10e6);
        uint64 first = hireC.hiredUntil(AGENT, alice);
        vm.warp(block.timestamp + 10 days);
        _pay(address(usdc), 10e6);
        assertEq(hireC.hiredUntil(AGENT, alice), first + 30 days);
        vm.warp(first + 30 days + 1);
        assertFalse(hireC.isHired(AGENT, alice));
    }

    function test_rejectsUnderpaymentUnknownTokenAndInactivePlan() public {
        usdc.mint(alice, 5e6);
        vm.startPrank(alice);
        usdc.approve(address(hireC), 5e6);
        vm.expectRevert(abi.encodeWithSelector(StrategyHire.Underpaid.selector, 5e6, 10e6));
        hireC.hire{value: 0.01 ether}(AGENT, address(usdc), 5e6, 0);
        vm.expectRevert(abi.encodeWithSelector(StrategyHire.TokenNotAccepted.selector, address(weth)));
        hireC.hire{value: 0.01 ether}(AGENT, address(weth), 1e18, 0);
        vm.expectRevert(abi.encodeWithSelector(StrategyHire.PlanInactive.selector, keccak256("nobody")));
        hireC.hire{value: 0.01 ether}(keccak256("nobody"), address(usdc), 5e6, 0);
        vm.stopPrank();
    }

    function test_rejectsMissingCcipFee() public {
        usdc.mint(alice, 10e6);
        vm.startPrank(alice);
        usdc.approve(address(hireC), 10e6);
        vm.expectRevert(abi.encodeWithSelector(StrategyHire.InsufficientCcipFee.selector, 0, ccip.flatFee()));
        hireC.hire(AGENT, address(usdc), 10e6, 0);
        vm.stopPrank();
    }

    function test_onlyOperatorSetsPrices() public {
        vm.expectRevert(StrategyHire.NotOperator.selector);
        vm.prank(alice);
        hireC.setPlan(AGENT, 1, 30, true);
    }

    function test_receiverRejectsUnknownSender_andHoldsUntilPayoutSet() public {
        bytes32 other = keccak256("new-agent");
        vm.prank(leaderboardOperator);
        hireC.setPlan(other, 10e6, 30, true);
        usdc.mint(alice, 10e6);
        vm.startPrank(alice);
        usdc.approve(address(hireC), 10e6);
        hireC.hire{value: 0.01 ether}(other, address(usdc), 10e6, 0);
        vm.stopPrank();
        assertEq(recv.held(other), 20e18, "no payout wallet yet: held");
        address w = makeAddr("lateWallet");
        vm.prank(owner);
        recv.setPayout(other, w);
        assertEq(zeroG.balanceOf(w), 20e18, "released on registration");
        assertEq(recv.held(other), 0);

        // a message from anything but the allow-listed StrategyHire is refused
        vm.prank(owner);
        recv.setAllowedSender(LOCAL_SELECTOR, address(hireC), false);
        usdc.mint(alice, 10e6);
        vm.startPrank(alice);
        usdc.approve(address(hireC), 10e6);
        vm.expectRevert(abi.encodeWithSelector(HireReceiver.UnknownSender.selector, LOCAL_SELECTOR, address(hireC)));
        hireC.hire{value: 0.01 ether}(AGENT, address(usdc), 10e6, 0);
        vm.stopPrank();
    }
}
