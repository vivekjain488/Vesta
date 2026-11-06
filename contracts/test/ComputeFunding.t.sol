// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ComputeTreasury} from "../src/ComputeTreasury.sol";

contract FundingWrapped0G is ERC20 {
    constructor() ERC20("Wrapped test 0G", "W0G") {}
    function deposit() external payable { _mint(msg.sender, msg.value); }
    function withdraw(uint256 amount) external {
        _burn(msg.sender, amount);
        (bool ok,) = payable(msg.sender).call{value: amount}("");
        require(ok);
    }
}

contract FundingLedger {
    mapping(address => uint256) public credit;
    bool public rejectDeposit;
    function setReject(bool value) external { rejectDeposit = value; }
    function depositFundFor(address recipient) external payable {
        require(!rejectDeposit, "ledger rejected");
        credit[recipient] += msg.value;
    }
}

contract ComputeFundingTest is Test {
    bytes32 constant AGENT = keccak256("agent");
    bytes32 constant OP = keccak256("funding-intent");
    address operator;
    FundingWrapped0G wrapped;
    FundingLedger ledger;
    ComputeTreasury treasury;

    function setUp() public {
        vm.warp(1_800_000_000);
        operator = makeAddr("operator");
        wrapped = new FundingWrapped0G();
        ledger = new FundingLedger();
        treasury = new ComputeTreasury(address(0x1234), address(wrapped), address(this));
        treasury.setUnwrap(true);
        treasury.setLedgerManager(address(ledger));
        treasury.configureAgent(AGENT, operator, 2 ether);
        vm.deal(address(this), 10 ether);
        wrapped.deposit{value: 5 ether}();
        wrapped.approve(address(treasury), 5 ether);
        treasury.seed(AGENT, 5 ether);
    }

    function test_depositsDirectlyForOperatorWithoutIntermediateWalletTransfer() public {
        vm.prank(operator);
        treasury.fundLedger(AGENT, OP, 1 ether);
        assertEq(ledger.credit(operator), 1 ether);
        assertEq(treasury.balanceOf(AGENT), 4 ether);
        assertEq(wrapped.balanceOf(operator), 0);
        assertEq(operator.balance, 0);
        assertTrue(treasury.fundedOperations(AGENT, OP));
    }

    function test_sameOperationCannotDepositTwiceAfterUnknownReceipt() public {
        vm.startPrank(operator);
        treasury.fundLedger(AGENT, OP, 1 ether);
        vm.expectRevert(ComputeTreasury.Duplicate.selector);
        treasury.fundLedger(AGENT, OP, 1 ether);
        vm.stopPrank();
        assertEq(ledger.credit(operator), 1 ether);
    }

    function test_failedDepositRollsBackUnwrapCreditCapAndOperationId() public {
        ledger.setReject(true);
        vm.prank(operator);
        vm.expectRevert("ledger rejected");
        treasury.fundLedger(AGENT, OP, 1 ether);
        assertEq(treasury.balanceOf(AGENT), 5 ether);
        assertEq(wrapped.balanceOf(address(treasury)), 5 ether);
        assertFalse(treasury.fundedOperations(AGENT, OP));
        ledger.setReject(false);
        vm.prank(operator);
        treasury.fundLedger(AGENT, OP, 2 ether);
        assertEq(ledger.credit(operator), 2 ether);
    }

    function test_legacyWithdrawalsAndDirectDepositsShareDailyCap() public {
        vm.startPrank(operator);
        treasury.withdrawForLedger(AGENT, 1 ether);
        treasury.fundLedger(AGENT, OP, 1 ether);
        vm.expectRevert(abi.encodeWithSelector(ComputeTreasury.OverDailyCap.selector, 1, 0));
        treasury.fundLedger(AGENT, keccak256("next"), 1);
        vm.stopPrank();
    }

    function test_reducingCapBelowPriorSpendDoesNotUnderflow() public {
        vm.prank(operator);
        treasury.fundLedger(AGENT, OP, 1 ether);
        treasury.configureAgent(AGENT, operator, 0.5 ether);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(ComputeTreasury.OverDailyCap.selector, 1, 0));
        treasury.fundLedger(AGENT, keccak256("next"), 1);
    }

    function test_anotherAgentCannotUseThisAgentsFunds() public {
        address other = makeAddr("other");
        bytes32 otherId = keccak256("other");
        treasury.configureAgent(otherId, other, 2 ether);
        vm.prank(other);
        vm.expectRevert(ComputeTreasury.NotOperator.selector);
        treasury.fundLedger(AGENT, OP, 1 ether);
        vm.prank(other);
        vm.expectRevert("balance");
        treasury.fundLedger(otherId, OP, 1 ether);
    }
}
